import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GatewayConfig } from '../../config.js';
import {
  assertTelegramDailyBudget,
  assertTelegramTradePolicy,
  recordConfirmedTradeRequest,
  recordTelegramHandledChatAndMaybeGetCostEstimate,
  recordTelegramTokenUsage,
} from './safety-policy.js';

function buildConfig(overrides?: Partial<GatewayConfig['safety']> & { heartbeatEnabled?: boolean }): GatewayConfig {
  return {
    gateway: {
      accountId: 'default',
      logLevel: 'info',
      heartbeat: {
        enabled: overrides?.heartbeatEnabled ?? true,
        intervalMinutes: 10,
        maxIterations: 6,
      },
    },
    channels: {
      whatsapp: { enabled: false, accounts: {}, allowFrom: [] },
      telegram: { enabled: true, accounts: {}, allowFrom: ['*'] },
    },
    bindings: [],
    safety: {
      dailyTokenBudget: {
        enabled: overrides?.dailyTokenBudget?.enabled ?? true,
        maxTokens: overrides?.dailyTokenBudget?.maxTokens ?? 100,
        timezone: overrides?.dailyTokenBudget?.timezone ?? 'UTC',
      },
      tradeRequests: {
        enabled: overrides?.tradeRequests?.enabled ?? true,
        requireHeartbeat: overrides?.tradeRequests?.requireHeartbeat ?? true,
        maxDailyRequests: overrides?.tradeRequests?.maxDailyRequests ?? 2,
      },
    },
  };
}

let tempDir: string | null = null;

afterEach(() => {
  delete process.env.DEXTER_TELEGRAM_SAFETY_STATE_PATH;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('telegram safety policy', () => {
  test('blocks once the daily token budget is exhausted', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dexter-safety-'));
    process.env.DEXTER_TELEGRAM_SAFETY_STATE_PATH = join(tempDir, 'telegram-safety.json');

    const cfg = buildConfig();
    recordTelegramTokenUsage({
      config: cfg,
      tokenUsage: { inputTokens: 40, outputTokens: 70, totalTokens: 110 },
    });

    expect(() => assertTelegramDailyBudget({ config: cfg })).toThrow('Daily Telegram token budget exhausted');
  });

  test('requires heartbeat when configured for trade writes', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dexter-safety-'));
    process.env.DEXTER_TELEGRAM_SAFETY_STATE_PATH = join(tempDir, 'telegram-safety.json');

    const cfg = buildConfig({ heartbeatEnabled: false });
    await expect(assertTelegramTradePolicy({ config: cfg })).rejects.toThrow('heartbeat gate');
  });

  test('blocks once the daily confirmed trade-request limit is reached', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dexter-safety-'));
    process.env.DEXTER_TELEGRAM_SAFETY_STATE_PATH = join(tempDir, 'telegram-safety.json');

    const cfg = buildConfig();
    recordConfirmedTradeRequest({ config: cfg });
    recordConfirmedTradeRequest({ config: cfg });

    await expect(assertTelegramTradePolicy({ config: cfg })).rejects.toThrow('Daily trade-request limit reached');
  });

  test('returns a running cost estimate every tenth Telegram chat', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dexter-safety-'));
    process.env.DEXTER_TELEGRAM_SAFETY_STATE_PATH = join(tempDir, 'telegram-safety.json');

    const cfg = buildConfig();
    recordTelegramTokenUsage({
      config: cfg,
      tokenUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    });

    let estimate: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      estimate = recordTelegramHandledChatAndMaybeGetCostEstimate({
        modelId: 'gemini-2.5-flash-lite',
        config: cfg,
      });
    }

    expect(estimate).toContain('Cost estimate:');
    expect(estimate).toContain('after 10 Telegram chats today');
    expect(estimate).toContain('1,000 input + 500 output tokens');
  });
});
