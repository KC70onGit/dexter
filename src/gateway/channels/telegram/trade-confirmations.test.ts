import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GatewayConfig } from '../../config.js';
import {
  cancelPendingTelegramTrade,
  confirmPendingTelegramTrade,
  extractTelegramTradeMarker,
  getPendingTelegramTrade,
  preparePendingTelegramTrade,
} from './trade-confirmations.js';

const realFetch = globalThis.fetch;
let tempDir: string | null = null;

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function installFetchMock(
  implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void {
  globalThis.fetch = Object.assign(implementation, {
    preconnect: realFetch.preconnect,
  });
}

const tradeEnabledConfig: GatewayConfig = {
  gateway: {
    accountId: 'default',
    logLevel: 'info',
  },
  channels: {
    whatsapp: { enabled: false, accounts: {}, allowFrom: [] },
    telegram: { enabled: true, accounts: {}, allowFrom: ['*'] },
  },
  bindings: [],
  safety: {
    dailyTokenBudget: {
      enabled: false,
      maxTokens: 0,
      timezone: 'UTC',
    },
    tradeRequests: {
      enabled: true,
      requireHeartbeat: false,
      maxDailyRequests: 10,
    },
  },
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dexter-trade-confirm-'));
  process.env.DEXTER_TELEGRAM_SAFETY_STATE_PATH = join(tempDir, 'telegram-safety.json');
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.DEXTER_TELEGRAM_SAFETY_STATE_PATH;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('telegram trade confirmations', () => {
  test('extracts and strips confirmation markers', () => {
    const parsed = extractTelegramTradeMarker(
      'Prepared trade request.\n[[DEXTER_TRADE_CONFIRMATION token=abc-123]]',
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.token).toBe('abc-123');
    expect(parsed?.text).toBe('Prepared trade request.');
  });

  test('prepares and cancels a pending trade', async () => {
    installFetchMock(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({
          ok: true,
          updated_at: new Date().toISOString(),
          session_state: 'LIVE',
          signals_total: 3,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/autotrade-status')) {
        return new Response(JSON.stringify({
          ok: true,
          autotrade_enabled: true,
          whitelist: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const pending = await preparePendingTelegramTrade({
      chatId: 'chat-1',
      userId: 'user-1',
      ticker: 'aapl',
      side: 'BUY',
      amountUsd: 5000,
      config: tradeEnabledConfig,
    });
    expect(getPendingTelegramTrade(pending.token)?.request.ticker).toBe('AAPL');

    const cancelled = cancelPendingTelegramTrade({
      token: pending.token,
      chatId: 'chat-1',
      userId: 'user-1',
    });
    expect(cancelled.ok).toBe(true);
    expect(getPendingTelegramTrade(pending.token)).toBeNull();
  });

  test('confirms a pending trade through the monitor server', async () => {
    installFetchMock(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({
          ok: true,
          updated_at: new Date().toISOString(),
          session_state: 'LIVE',
          signals_total: 1,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/autotrade-status')) {
        return new Response(JSON.stringify({
          ok: true,
          autotrade_enabled: true,
          whitelist: ['AAPL'],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/trade')) {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({
          ok: true,
          request_id: 'req-12345678',
          enqueued: true,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const pending = await preparePendingTelegramTrade({
      chatId: 'chat-2',
      userId: 'user-2',
      ticker: 'AAPL',
      side: 'BUY',
      amountUsd: 5000,
      config: tradeEnabledConfig,
    });

    const result = await confirmPendingTelegramTrade({
      token: pending.token,
      chatId: 'chat-2',
      userId: 'user-2',
      config: tradeEnabledConfig,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Trade request sent');
    expect(getPendingTelegramTrade(pending.token)).toBeNull();
  });

  test('blocks trade preparation when the market is closed', async () => {
    installFetchMock(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({
          ok: true,
          updated_at: new Date().toISOString(),
          session_state: 'MARKET_CLOSED',
          signals_total: 0,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(preparePendingTelegramTrade({
      chatId: 'chat-3',
      userId: 'user-3',
      ticker: 'AAPL',
      side: 'BUY',
      amountUsd: 5000,
      config: tradeEnabledConfig,
    })).rejects.toThrow('MARKET_CLOSED');
  });

  test('blocks stale MARKET_CLOSED health as stale monitor state first', async () => {
    installFetchMock(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({
          ok: true,
          updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          session_state: 'MARKET_CLOSED',
          signals_total: 0,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(preparePendingTelegramTrade({
      chatId: 'chat-4',
      userId: 'user-4',
      ticker: 'AAPL',
      side: 'BUY',
      amountUsd: 5000,
      config: tradeEnabledConfig,
    })).rejects.toThrow('stale and last reported MARKET_CLOSED');
  });
});
