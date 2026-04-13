import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TokenUsage } from '../../../agent/types.js';
import type { GatewayConfig } from '../../config.js';
import { loadGatewayConfig } from '../../config.js';
import { buildHeartbeatQuery } from '../../heartbeat/prompt.js';
import { dexterPath } from '../../../utils/paths.js';

type SafetyState = {
  days: Record<string, { totalTokens: number; confirmedTradeRequests: number; updatedAt: string }>;
};

function getSafetyStatePath(): string {
  return process.env.DEXTER_TELEGRAM_SAFETY_STATE_PATH || dexterPath('telegram-safety.json');
}

function resolveConfig(config?: GatewayConfig): GatewayConfig {
  return config ?? loadGatewayConfig();
}

function getDateKey(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function loadSafetyState(): SafetyState {
  const path = getSafetyStatePath();
  if (!existsSync(path)) {
    return { days: {} };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SafetyState;
  } catch {
    return { days: {} };
  }
}

function saveSafetyState(state: SafetyState): void {
  const path = getSafetyStatePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
}

function getTodayBucket(cfg: GatewayConfig, state?: SafetyState): {
  key: string;
  state: SafetyState;
  bucket: { totalTokens: number; confirmedTradeRequests: number; updatedAt: string };
} {
  const nextState = state ?? loadSafetyState();
  const key = getDateKey(cfg.safety.dailyTokenBudget.timezone);
  const bucket = nextState.days[key] ?? {
    totalTokens: 0,
    confirmedTradeRequests: 0,
    updatedAt: new Date().toISOString(),
  };
  nextState.days[key] = bucket;
  return { key, state: nextState, bucket };
}

export function recordTelegramTokenUsage(params: {
  tokenUsage?: TokenUsage;
  config?: GatewayConfig;
}): void {
  const cfg = resolveConfig(params.config);
  const totalTokens = params.tokenUsage?.totalTokens ?? 0;
  if (!cfg.safety.dailyTokenBudget.enabled || totalTokens <= 0) {
    return;
  }
  const { state, bucket } = getTodayBucket(cfg);
  bucket.totalTokens += totalTokens;
  bucket.updatedAt = new Date().toISOString();
  saveSafetyState(state);
}

export function assertTelegramDailyBudget(params?: { config?: GatewayConfig }): void {
  const cfg = resolveConfig(params?.config);
  if (!cfg.safety.dailyTokenBudget.enabled) {
    return;
  }
  const { bucket } = getTodayBucket(cfg);
  if (bucket.totalTokens >= cfg.safety.dailyTokenBudget.maxTokens) {
    throw new Error(
      `Daily Telegram token budget exhausted (${bucket.totalTokens}/${cfg.safety.dailyTokenBudget.maxTokens}).`,
    );
  }
}

export async function assertTelegramTradePolicy(params?: { config?: GatewayConfig }): Promise<void> {
  const cfg = resolveConfig(params?.config);
  if (!cfg.safety.tradeRequests.enabled) {
    throw new Error('Telegram trade requests are disabled in gateway policy.');
  }
  // FIX-177: Telegram is only allowed to stage trade writes when the heartbeat-gated
  // policy is explicitly enabled and still inside the daily request budget.
  if (cfg.safety.tradeRequests.requireHeartbeat) {
    if (!cfg.gateway.heartbeat?.enabled) {
      throw new Error('Telegram trade requests require the heartbeat gate to be enabled.');
    }
    const heartbeatQuery = await buildHeartbeatQuery();
    if (heartbeatQuery === null) {
      throw new Error('Telegram trade requests require a non-empty heartbeat checklist.');
    }
  }
  const { bucket } = getTodayBucket(cfg);
  if (bucket.confirmedTradeRequests >= cfg.safety.tradeRequests.maxDailyRequests) {
    throw new Error(
      `Daily trade-request limit reached (${bucket.confirmedTradeRequests}/${cfg.safety.tradeRequests.maxDailyRequests}).`,
    );
  }
}

export function recordConfirmedTradeRequest(params?: { config?: GatewayConfig }): void {
  const cfg = resolveConfig(params?.config);
  const { state, bucket } = getTodayBucket(cfg);
  bucket.confirmedTradeRequests += 1;
  bucket.updatedAt = new Date().toISOString();
  saveSafetyState(state);
}
