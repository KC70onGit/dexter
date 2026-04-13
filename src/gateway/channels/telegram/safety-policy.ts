import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TokenUsage } from '../../../agent/types.js';
import type { GatewayConfig } from '../../config.js';
import { loadGatewayConfig } from '../../config.js';
import { buildHeartbeatQuery } from '../../heartbeat/prompt.js';
import { dexterPath } from '../../../utils/paths.js';

type SafetyState = {
  days: Record<
    string,
    {
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      handledChatCommands: number;
      confirmedTradeRequests: number;
      updatedAt: string;
    }
  >;
};

type DailySafetyBucket = SafetyState['days'][string];

const TELEGRAM_COST_REPORT_EVERY = 10;

const MODEL_PRICING_USD_PER_MILLION: Record<
  string,
  { input: number; output: number }
> = {
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-3-flash-preview': { input: 0.50, output: 3.00 },
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
  bucket: DailySafetyBucket;
} {
  const nextState = state ?? loadSafetyState();
  return getBucketForDateKey(getDateKey(cfg.safety.dailyTokenBudget.timezone), nextState);
}

function getBucketForDateKey(key: string, state?: SafetyState): {
  key: string;
  state: SafetyState;
  bucket: DailySafetyBucket;
} {
  const nextState = state ?? loadSafetyState();
  const bucket = nextState.days[key] ?? {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    handledChatCommands: 0,
    confirmedTradeRequests: 0,
    updatedAt: new Date().toISOString(),
  };
  bucket.totalTokens = bucket.totalTokens ?? 0;
  bucket.inputTokens = bucket.inputTokens ?? 0;
  bucket.outputTokens = bucket.outputTokens ?? 0;
  bucket.handledChatCommands = bucket.handledChatCommands ?? 0;
  bucket.confirmedTradeRequests = bucket.confirmedTradeRequests ?? 0;
  nextState.days[key] = bucket;
  return { key, state: nextState, bucket };
}

export function recordTelegramTokenUsage(params: {
  tokenUsage?: TokenUsage;
  config?: GatewayConfig;
}): void {
  const cfg = resolveConfig(params.config);
  const totalTokens = params.tokenUsage?.totalTokens ?? 0;
  if (totalTokens <= 0) {
    return;
  }
  const { state, bucket } = getTodayBucket(cfg);
  bucket.totalTokens += totalTokens;
  bucket.inputTokens += params.tokenUsage?.inputTokens ?? 0;
  bucket.outputTokens += params.tokenUsage?.outputTokens ?? 0;
  bucket.updatedAt = new Date().toISOString();
  saveSafetyState(state);
}

function formatUsdEstimate(value: number): string {
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.1) {
    return `$${value.toFixed(3)}`;
  }
  return `$${value.toFixed(4)}`;
}

function estimateDailyTelegramCostUsd(bucket: DailySafetyBucket, modelId: string): number | null {
  const pricing = MODEL_PRICING_USD_PER_MILLION[modelId];
  if (!pricing) {
    return null;
  }

  return (
    (bucket.inputTokens / 1_000_000) * pricing.input
    + (bucket.outputTokens / 1_000_000) * pricing.output
  );
}

export function recordTelegramHandledChatAndMaybeGetCostEstimate(params: {
  modelId: string;
  config?: GatewayConfig;
}): string | null {
  const cfg = resolveConfig(params.config);
  const { state, bucket } = getTodayBucket(cfg);
  bucket.handledChatCommands += 1;
  bucket.updatedAt = new Date().toISOString();
  saveSafetyState(state);

  // [FIX-179] Attach a lightweight running cost estimate every 10 Telegram chats.
  if (bucket.handledChatCommands % TELEGRAM_COST_REPORT_EVERY !== 0) {
    return null;
  }

  const estimatedCostUsd = estimateDailyTelegramCostUsd(bucket, params.modelId);
  const costText = estimatedCostUsd === null
    ? 'cost estimate unavailable for the current model'
    : `${formatUsdEstimate(estimatedCostUsd)} today`;

  return [
    'Cost estimate:',
    `${costText} after ${bucket.handledChatCommands} Telegram chats today.`,
    `Recorded usage: ${bucket.inputTokens.toLocaleString()} input + ${bucket.outputTokens.toLocaleString()} output tokens.`,
  ].join(' ');
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
