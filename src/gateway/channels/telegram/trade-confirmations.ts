import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GatewayConfig } from '../../config.js';
import { dexterPath } from '../../../utils/paths.js';
import { AlgoTraderGatewayClient } from '../../../tools/algotrader/client.js';
import { assertTelegramTradePolicy, recordConfirmedTradeRequest } from './safety-policy.js';

export type PendingTelegramTrade = {
  token: string;
  chatId: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  request: {
    request_id: string;
    requested_at: string;
    source: 'telegram';
    chat_id: string;
    user_id: string;
    side: 'BUY' | 'SELL';
    trade_intent: 'OPEN' | 'ADD';
    ticker: string;
    amount_usd: number;
  };
  summary: string;
};

type TradeAuditEvent = {
  ts: string;
  event:
    | 'prepared'
    | 'prepare_blocked'
    | 'confirmed'
    | 'confirm_blocked'
    | 'cancelled'
    | 'expired';
  token?: string;
  request_id?: string;
  ticker?: string;
  side?: string;
  amount_usd?: number;
  reason?: string;
  chat_id?: string;
  user_id?: string;
};

const PENDING_TTL_MS = 15 * 60 * 1000;
const pendingTrades = new Map<string, PendingTelegramTrade>();
const AUDIT_PATH = dexterPath('telegram-trade-audit.jsonl');

function nowIso(): string {
  return new Date().toISOString();
}

function ensureAuditDir(): void {
  const dir = dirname(AUDIT_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function audit(event: TradeAuditEvent): void {
  ensureAuditDir();
  appendFileSync(AUDIT_PATH, `${JSON.stringify(event)}\n`, 'utf8');
}

function cleanupExpired(): void {
  const now = Date.now();
  for (const [token, pending] of pendingTrades.entries()) {
    if (Date.parse(pending.expiresAt) <= now) {
      pendingTrades.delete(token);
      audit({
        ts: nowIso(),
        event: 'expired',
        token,
        request_id: pending.request.request_id,
        ticker: pending.request.ticker,
        side: pending.request.side,
        amount_usd: pending.request.amount_usd,
        chat_id: pending.chatId,
        user_id: pending.userId,
      });
    }
  }
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function normalizeSide(side: string): 'BUY' | 'SELL' {
  const normalized = side.trim().toUpperCase();
  if (normalized !== 'BUY' && normalized !== 'SELL') {
    throw new Error('Side must be BUY or SELL.');
  }
  return normalized;
}

function normalizeTradeIntent(tradeIntent: string | undefined): 'OPEN' | 'ADD' {
  const normalized = (tradeIntent ?? 'OPEN').trim().toUpperCase();
  if (normalized !== 'OPEN' && normalized !== 'ADD') {
    throw new Error('Trade intent must be OPEN or ADD.');
  }
  return normalized;
}

async function assertTradeAllowed(client: AlgoTraderGatewayClient, ticker: string): Promise<void> {
  const health = await client.getHealth();
  const sessionState = String(health.data.session_state ?? '').trim().toUpperCase();
  // FIX-177: Telegram remains a conversational ingress only; execution requests must
  // fail closed whenever AlgoTrader is stale, closed, or not ready for live writes.
  if (sessionState === 'NO_DATA') {
    throw new Error('AlgoTrader reports NO_DATA. Trade requests are blocked.');
  }
  if (sessionState === 'MARKET_CLOSED') {
    throw new Error('AlgoTrader reports MARKET_CLOSED. Trade requests are blocked until the market is open.');
  }
  if (health.stale) {
    throw new Error('AlgoTrader health is stale. Trade requests are blocked until live state is fresh.');
  }

  const autotradeStatus = await client.getAutotradeStatus();
  const whitelist = autotradeStatus.whitelist;
  if (whitelist.length > 0 && !whitelist.includes(ticker)) {
    throw new Error(`${ticker} is not in the AlgoTrader whitelist.`);
  }
}

export async function preparePendingTelegramTrade(params: {
  chatId: string;
  userId: string;
  ticker: string;
  side: string;
  amountUsd: number;
  tradeIntent?: string;
  baseUrl?: string;
  config?: GatewayConfig;
}): Promise<PendingTelegramTrade> {
  cleanupExpired();

  const ticker = normalizeTicker(params.ticker);
  const side = normalizeSide(params.side);
  const tradeIntent = normalizeTradeIntent(params.tradeIntent);
  const amountUsd = Number(params.amountUsd);

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error('Amount must be a positive dollar value.');
  }

  await assertTelegramTradePolicy({ config: params.config });
  const client = new AlgoTraderGatewayClient(params.baseUrl);
  await assertTradeAllowed(client, ticker);

  const token = crypto.randomUUID();
  const requestId = crypto.randomUUID().replace(/-/g, '');
  const requestedAt = nowIso();
  const pending: PendingTelegramTrade = {
    token,
    chatId: params.chatId,
    userId: params.userId,
    createdAt: requestedAt,
    expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
    request: {
      request_id: requestId,
      requested_at: requestedAt,
      source: 'telegram',
      chat_id: params.chatId,
      user_id: params.userId,
      side,
      trade_intent: tradeIntent,
      ticker,
      amount_usd: amountUsd,
    },
    summary: `${tradeIntent} ${side} ${ticker} for $${amountUsd.toFixed(2)}`,
  };

  pendingTrades.set(token, pending);
  audit({
    ts: requestedAt,
    event: 'prepared',
    token,
    request_id: requestId,
    ticker,
    side,
    amount_usd: amountUsd,
    chat_id: params.chatId,
    user_id: params.userId,
  });

  return pending;
}

export function extractTelegramTradeMarker(text: string): { token: string; text: string } | null {
  const match = text.match(/\[\[DEXTER_TRADE_CONFIRMATION token=([a-f0-9-]+)\]\]/i);
  if (!match) {
    return null;
  }
  const stripped = text.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trim();
  return { token: match[1], text: stripped };
}

export function getPendingTelegramTrade(token: string): PendingTelegramTrade | null {
  cleanupExpired();
  return pendingTrades.get(token) ?? null;
}

export function cancelPendingTelegramTrade(params: {
  token: string;
  chatId: string;
  userId: string;
}): { ok: boolean; message: string } {
  cleanupExpired();
  const pending = pendingTrades.get(params.token);
  if (!pending) {
    return { ok: false, message: 'That trade confirmation is no longer available.' };
  }
  if (pending.chatId !== params.chatId || pending.userId !== params.userId) {
    return { ok: false, message: 'That confirmation does not belong to this chat.' };
  }
  pendingTrades.delete(params.token);
  audit({
    ts: nowIso(),
    event: 'cancelled',
    token: params.token,
    request_id: pending.request.request_id,
    ticker: pending.request.ticker,
    side: pending.request.side,
    amount_usd: pending.request.amount_usd,
    chat_id: params.chatId,
    user_id: params.userId,
  });
  return { ok: true, message: `Cancelled ${pending.summary}.` };
}

export async function confirmPendingTelegramTrade(params: {
  token: string;
  chatId: string;
  userId: string;
  baseUrl?: string;
  config?: GatewayConfig;
}): Promise<{ ok: boolean; message: string }> {
  cleanupExpired();
  const pending = pendingTrades.get(params.token);
  if (!pending) {
    return { ok: false, message: 'That trade confirmation is no longer available.' };
  }
  if (pending.chatId !== params.chatId || pending.userId !== params.userId) {
    return { ok: false, message: 'That confirmation does not belong to this chat.' };
  }

  const client = new AlgoTraderGatewayClient(params.baseUrl);
  try {
    // FIX-177: re-check the full policy and live health at confirm time so a previously
    // prepared request cannot slip through after conditions deteriorate.
    await assertTelegramTradePolicy({ config: params.config });
    await assertTradeAllowed(client, pending.request.ticker);
    const response = await client.submitTrade(pending.request);
    pendingTrades.delete(params.token);
    recordConfirmedTradeRequest({ config: params.config });
    audit({
      ts: nowIso(),
      event: 'confirmed',
      token: params.token,
      request_id: pending.request.request_id,
      ticker: pending.request.ticker,
      side: pending.request.side,
      amount_usd: pending.request.amount_usd,
      chat_id: params.chatId,
      user_id: params.userId,
    });
    return {
      ok: true,
      message: `Trade request sent: ${pending.summary}. Request ID ${response.request_id.slice(0, 8)}.`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    audit({
      ts: nowIso(),
      event: 'confirm_blocked',
      token: params.token,
      request_id: pending.request.request_id,
      ticker: pending.request.ticker,
      side: pending.request.side,
      amount_usd: pending.request.amount_usd,
      reason,
      chat_id: params.chatId,
      user_id: params.userId,
    });
    return { ok: false, message: `Trade request blocked: ${reason}` };
  }
}
