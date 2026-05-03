export type AlgoTraderEnvelope<T> = {
  ok?: boolean;
  source: string;
  updated_at: string | null;
  stale: boolean;
  data: T;
};

type HealthResponse = {
  ok?: boolean;
  updated_at?: string | null;
  session_state?: string | null;
  signals_total?: number;
};

type HealthMonitorState = 'fresh' | 'stale' | 'no_data';

type AutotradeStatusResponse = {
  ok?: boolean;
  autotrade_enabled?: boolean;
  whitelist?: string[];
};

type StatusResponse = {
  ok?: boolean;
  status?: string;
  status_label?: string;
  gateway_host?: string;
  gateway_ports_checked?: number[];
  gateway_reachable?: boolean;
  gateway_port?: number | null;
  engine_ib_connected?: boolean;
  updated_at?: string | null;
  age_sec?: number | null;
  is_stale?: boolean;
  session_state?: string | null;
  generated_at?: string | null;
};

type StatusInterpretation = {
  brokerState: 'connected' | 'gateway_only' | 'unreachable' | 'unknown';
  brokerStateAuthoritative: boolean;
  operatorGuidance: string;
};

type ChartResponse = {
  ok?: boolean;
  chart?: unknown;
};

type SubmitTradeRequest = {
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

type SubmitTradeResponse = {
  ok?: boolean;
  request_id: string;
  enqueued?: boolean;
};

const DEFAULT_BASE_URL = process.env.ALGOTRADER_BASE_URL?.trim() || 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function deriveStaleness(updatedAt: string | null | undefined, maxAgeSeconds: number): boolean {
  if (!updatedAt) {
    return true;
  }
  const timestampMs = Date.parse(updatedAt);
  if (Number.isNaN(timestampMs)) {
    return true;
  }
  return Date.now() - timestampMs > maxAgeSeconds * 1000;
}

function normalizeSessionState(sessionState: string | null | undefined): string | null {
  const normalized = sessionState?.trim().toUpperCase();
  return normalized || null;
}

// [FIX-185] Derive IBKR broker connectivity interpretation from /api/status fields.
function deriveStatusInterpretation(
  gatewayReachable: boolean,
  engineIbConnected: boolean,
  isStale: boolean,
  gatewayPort: number | null | undefined,
): StatusInterpretation {
  if (isStale) {
    return {
      brokerState: 'unknown',
      brokerStateAuthoritative: false,
      operatorGuidance:
        'Runtime status snapshot is stale. Broker connectivity state may be outdated — verify manually.',
    };
  }

  if (gatewayReachable && engineIbConnected) {
    const portSuffix = gatewayPort ? ` (port ${gatewayPort})` : '';
    return {
      brokerState: 'connected',
      brokerStateAuthoritative: true,
      operatorGuidance: `IBKR gateway is reachable${portSuffix} and engine is connected. Stack is fully online.`,
    };
  }

  if (gatewayReachable && !engineIbConnected) {
    const portSuffix = gatewayPort ? ` (port ${gatewayPort})` : '';
    return {
      brokerState: 'gateway_only',
      brokerStateAuthoritative: true,
      operatorGuidance:
        `IBKR gateway is reachable${portSuffix} but engine is NOT connected to IBKR. Stack is degraded — the engine may need a restart or IBKR login.`,
    };
  }

  if (!gatewayReachable && engineIbConnected) {
    return {
      brokerState: 'gateway_only',
      brokerStateAuthoritative: false,
      operatorGuidance:
        'Gateway probe failed but engine reports connected. Possible transient network issue or probe lag.',
    };
  }

  return {
    brokerState: 'unreachable',
    brokerStateAuthoritative: true,
    operatorGuidance:
      'IBKR gateway is unreachable and engine is not connected. IBKR is offline or TWS/Gateway is not running.',
  };
}

function deriveHealthInterpretation(sessionState: string | null, stale: boolean): {
  monitorState: HealthMonitorState;
  sessionStateAuthoritative: boolean;
  marketHoursInferenceAllowed: boolean;
  operatorGuidance: string;
} {
  if (sessionState === 'NO_DATA') {
    return {
      monitorState: 'no_data',
      sessionStateAuthoritative: false,
      marketHoursInferenceAllowed: false,
      operatorGuidance:
        'AlgoTrader has no live session data. Treat the monitor as unavailable; this does not prove the exchange is open or closed.',
    };
  }

  if (stale && sessionState === 'MARKET_CLOSED') {
    return {
      monitorState: 'stale',
      sessionStateAuthoritative: false,
      marketHoursInferenceAllowed: false,
      operatorGuidance:
        'AlgoTrader last reported MARKET_CLOSED, but the snapshot is stale. Treat this as a stale monitor/offline signal, not proof of current exchange hours.',
    };
  }

  if (stale) {
    return {
      monitorState: 'stale',
      sessionStateAuthoritative: false,
      marketHoursInferenceAllowed: false,
      operatorGuidance:
        'AlgoTrader health is stale. Any reported session_state may be outdated, so live market status is unknown until the monitor refreshes.',
    };
  }

  if (sessionState === 'MARKET_CLOSED') {
    return {
      monitorState: 'fresh',
      sessionStateAuthoritative: true,
      marketHoursInferenceAllowed: true,
      operatorGuidance: 'Fresh monitor snapshot says MARKET_CLOSED.',
    };
  }

  if (sessionState === 'LIVE') {
    return {
      monitorState: 'fresh',
      sessionStateAuthoritative: true,
      marketHoursInferenceAllowed: true,
      operatorGuidance: 'Fresh monitor snapshot says LIVE.',
    };
  }

  return {
    monitorState: 'fresh',
    sessionStateAuthoritative: true,
    marketHoursInferenceAllowed: true,
    operatorGuidance: sessionState
      ? `Fresh monitor snapshot says ${sessionState}.`
      : 'Fresh monitor snapshot is missing session_state.',
  };
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`AlgoTrader returned non-JSON from ${response.url}`);
  }
}

export class AlgoTraderGatewayClient {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async request(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });
      const payload = await parseJson(response);
      if (!response.ok) {
        const error = isRecord(payload) && typeof payload.error === 'string' ? payload.error : response.statusText;
        throw new Error(`AlgoTrader ${path} failed: ${error}`);
      }
      if (isRecord(payload) && payload.ok === false && typeof payload.error === 'string') {
        throw new Error(`AlgoTrader ${path} failed: ${payload.error}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`AlgoTrader ${path} timed out after ${DEFAULT_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const payload = await parseJson(response);
      if (!response.ok) {
        const error = isRecord(payload) && typeof payload.error === 'string' ? payload.error : response.statusText;
        throw new Error(`AlgoTrader ${path} failed: ${error}`);
      }
      if (isRecord(payload) && payload.ok === false && typeof payload.error === 'string') {
        throw new Error(`AlgoTrader ${path} failed: ${payload.error}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`AlgoTrader ${path} timed out after ${DEFAULT_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getPositions(): Promise<AlgoTraderEnvelope<unknown[]>> {
    return this.request('/api/positions') as Promise<AlgoTraderEnvelope<unknown[]>>;
  }

  async getSignals(): Promise<AlgoTraderEnvelope<unknown[]>> {
    return this.request('/api/signals') as Promise<AlgoTraderEnvelope<unknown[]>>;
  }

  async getTrades(params?: { includeSim?: boolean }): Promise<AlgoTraderEnvelope<unknown[]>> {
    const query = params?.includeSim ? '?include_sim=true' : '';
    return this.request(`/api/trades${query}`) as Promise<AlgoTraderEnvelope<unknown[]>>;
  }

  async getAutotradeStatus(): Promise<{ autotradeEnabled: boolean; whitelist: string[] }> {
    const payload = (await this.request('/api/autotrade-status')) as AutotradeStatusResponse;
    return {
      autotradeEnabled: Boolean(payload.autotrade_enabled),
      whitelist: (payload.whitelist ?? []).map((ticker) => ticker.trim().toUpperCase()).filter(Boolean),
    };
  }

  async getHealth(): Promise<AlgoTraderEnvelope<Record<string, unknown>>> {
    const payload = (await this.request('/api/health')) as HealthResponse;
    const sessionState = normalizeSessionState(payload.session_state ?? null);
    const stale =
      sessionState === 'NO_DATA'
      || deriveStaleness(payload.updated_at ?? null, 30);
    // FIX-178: stale or NO_DATA health should degrade confidence in live state,
    // not be treated as definitive evidence of current market hours.
    const interpretation = deriveHealthInterpretation(sessionState, stale);
    return {
      source: 'health',
      updated_at: payload.updated_at ?? null,
      stale,
      data: {
        session_state: sessionState,
        signals_total: payload.signals_total ?? 0,
        monitor_state: interpretation.monitorState,
        session_state_authoritative: interpretation.sessionStateAuthoritative,
        market_hours_inference_allowed: interpretation.marketHoursInferenceAllowed,
        operator_guidance: interpretation.operatorGuidance,
      },
    };
  }

  async getChart(ticker: string): Promise<AlgoTraderEnvelope<unknown>> {
    const symbol = ticker.trim().toUpperCase();
    if (!symbol) {
      throw new Error('Ticker is required for AlgoTrader chart lookup.');
    }
    const payload = (await this.request(`/api/chart?ticker=${encodeURIComponent(symbol)}`)) as ChartResponse;
    return {
      source: 'chart_cache',
      updated_at: null,
      stale: false,
      data: payload.chart ?? null,
    };
  }

  // [FIX-185] Read /api/status for IBKR/runtime connectivity — the correct read surface
  // for broker questions (as opposed to /api/health which is for monitor/session freshness).
  async getStatus(): Promise<AlgoTraderEnvelope<Record<string, unknown>>> {
    const payload = (await this.request('/api/status')) as StatusResponse;
    const isStale = payload.is_stale ?? deriveStaleness(payload.updated_at ?? null, 45);
    const gatewayReachable = Boolean(payload.gateway_reachable);
    const engineIbConnected = Boolean(payload.engine_ib_connected);
    const gatewayPort = payload.gateway_port ?? null;
    const interpretation = deriveStatusInterpretation(
      gatewayReachable,
      engineIbConnected,
      isStale,
      gatewayPort,
    );
    return {
      source: 'runtime_status',
      updated_at: payload.updated_at ?? null,
      stale: isStale,
      data: {
        status: payload.status ?? 'unknown',
        status_label: payload.status_label ?? 'Unknown',
        gateway_reachable: gatewayReachable,
        gateway_port: gatewayPort,
        engine_ib_connected: engineIbConnected,
        session_state: normalizeSessionState(payload.session_state ?? null),
        broker_state: interpretation.brokerState,
        broker_state_authoritative: interpretation.brokerStateAuthoritative,
        operator_guidance: interpretation.operatorGuidance,
      },
    };
  }

  // [FIX-403] Read /api/market-regime for SPY regime + QQQ/VIX context.
  // The correct read surface for market environment questions (as opposed to
  // /api/health which is for monitor/session freshness).
  async getMarketRegime(): Promise<AlgoTraderEnvelope<Record<string, unknown>>> {
    const payload = (await this.request('/api/market-regime')) as Record<string, unknown>;
    const stale = Boolean(payload.stale ?? true);
    return {
      source: 'market_regime',
      updated_at: (payload.last_updated as string) ?? null,
      stale,
      data: payload,
    };
  }

  async submitTrade(request: SubmitTradeRequest): Promise<SubmitTradeResponse> {
    return this.post('/api/trade', request) as Promise<SubmitTradeResponse>;
  }
}
