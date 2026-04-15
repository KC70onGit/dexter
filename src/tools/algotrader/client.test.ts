import { afterEach, describe, expect, test } from 'bun:test';
import { AlgoTraderGatewayClient } from './client.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ALGOTRADER_BASE_URL;
});

describe('AlgoTraderGatewayClient', () => {
  test('normalizes /api/health into a shared envelope', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          updated_at: new Date().toISOString(),
          session_state: 'LIVE',
          signals_total: 7,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as typeof fetch;

    const client = new AlgoTraderGatewayClient('http://127.0.0.1:8787');
    const result = await client.getHealth();

    expect(result.source).toBe('health');
    expect(result.stale).toBe(false);
    expect(result.data).toEqual({
      session_state: 'LIVE',
      signals_total: 7,
      monitor_state: 'fresh',
      session_state_authoritative: true,
      market_hours_inference_allowed: true,
      operator_guidance: 'Fresh monitor snapshot says LIVE.',
    });
  });

  test('marks NO_DATA health as stale', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          updated_at: new Date().toISOString(),
          session_state: 'NO_DATA',
          signals_total: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as typeof fetch;

    const client = new AlgoTraderGatewayClient('http://127.0.0.1:8787');
    const result = await client.getHealth();
    expect(result.stale).toBe(true);
    expect(result.data).toMatchObject({
      session_state: 'NO_DATA',
      monitor_state: 'no_data',
      session_state_authoritative: false,
      market_hours_inference_allowed: false,
    });
  });

  test('treats stale MARKET_CLOSED as non-authoritative monitor state', async () => {
    const staleTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          updated_at: staleTimestamp,
          session_state: 'MARKET_CLOSED',
          signals_total: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as typeof fetch;

    const client = new AlgoTraderGatewayClient('http://127.0.0.1:8787');
    const result = await client.getHealth();

    expect(result.stale).toBe(true);
    expect(result.data).toMatchObject({
      session_state: 'MARKET_CLOSED',
      monitor_state: 'stale',
      session_state_authoritative: false,
      market_hours_inference_allowed: false,
    });
    expect(String(result.data.operator_guidance)).toContain('not proof of current exchange hours');
  });

  test('passes include_sim to the trades endpoint only when requested', async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = async (input) => {
      seenUrls.push(typeof input === 'string' ? input : input.url);
      return new Response(
        JSON.stringify({
          ok: true,
          source: 'breitstein_journal',
          updated_at: null,
          stale: false,
          data: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const client = new AlgoTraderGatewayClient('http://127.0.0.1:8787');
    await client.getTrades();
    await client.getTrades({ includeSim: true });

    expect(seenUrls).toEqual([
      'http://127.0.0.1:8787/api/trades',
      'http://127.0.0.1:8787/api/trades?include_sim=true',
    ]);
  });

  test('reads autotrade whitelist status', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          autotrade_enabled: true,
          whitelist: ['aapl', 'msft'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as typeof fetch;

    const client = new AlgoTraderGatewayClient('http://127.0.0.1:8787');
    const result = await client.getAutotradeStatus();

    expect(result).toEqual({
      autotradeEnabled: true,
      whitelist: ['AAPL', 'MSFT'],
    });
  });

  test('wraps chart responses into the shared envelope', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          chart: { ticker: 'AAPL', bars: [1, 2, 3] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as typeof fetch;

    const client = new AlgoTraderGatewayClient('http://127.0.0.1:8787');
    const result = await client.getChart('aapl');

    expect(result.source).toBe('chart_cache');
    expect(result.stale).toBe(false);
    expect(result.data).toEqual({ ticker: 'AAPL', bars: [1, 2, 3] });
  });

  test('submits a trade request through POST /api/trade', async () => {
    globalThis.fetch = async (_input, init) => {
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeDefined();
      return new Response(
        JSON.stringify({
          ok: true,
          request_id: 'req-1234',
          enqueued: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const client = new AlgoTraderGatewayClient('http://127.0.0.1:8787');
    const result = await client.submitTrade({
      request_id: 'req-1234',
      requested_at: new Date().toISOString(),
      source: 'telegram',
      chat_id: 'chat-1',
      user_id: 'user-1',
      side: 'BUY',
      trade_intent: 'OPEN',
      ticker: 'AAPL',
      amount_usd: 5000,
    });

    expect(result).toEqual({
      ok: true,
      request_id: 'req-1234',
      enqueued: true,
    });
  });

  // ====================================================================
  // FIX-185: /api/status — IBKR broker connectivity tests
  // ====================================================================

  test('getStatus returns connected when gateway reachable and engine connected', async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = async (input) => {
      seenUrls.push(typeof input === 'string' ? input : input.url);
      return new Response(
        JSON.stringify({
          ok: true,
          status: 'online',
          status_label: '✅ Online (port 4002)',
          gateway_reachable: true,
          gateway_port: 4002,
          engine_ib_connected: true,
          updated_at: new Date().toISOString(),
          is_stale: false,
          session_state: 'LIVE',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as typeof fetch;
    };

    const client = new AlgoTraderGatewayClient('http://127.0.0.1:8787');
    const result = await client.getStatus();

    expect(seenUrls).toEqual(['http://127.0.0.1:8787/api/status']);
    expect(result.source).toBe('runtime_status');
    expect(result.stale).toBe(false);
    expect(result.data).toMatchObject({
      status: 'online',
      gateway_reachable: true,
      gateway_port: 4002,
      engine_ib_connected: true,
      broker_state: 'connected',
      broker_state_authoritative: true,
    });
    expect(String(result.data.operator_guidance)).toContain('fully online');
  });

  test('getStatus returns gateway_only when gateway reachable but engine disconnected', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          status: 'degraded',
          status_label: '⚠️ Degraded',
          gateway_reachable: true,
          gateway_port: 4002,
          engine_ib_connected: false,
          updated_at: new Date().toISOString(),
          is_stale: false,
          session_state: 'LIVE',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as typeof fetch;

    const client = new AlgoTraderGatewayClient('http://127.0.0.1:8787');
    const result = await client.getStatus();

    expect(result.data).toMatchObject({
      broker_state: 'gateway_only',
      broker_state_authoritative: true,
      gateway_reachable: true,
      engine_ib_connected: false,
    });
    expect(String(result.data.operator_guidance)).toContain('NOT connected');
  });

  test('getStatus returns unreachable when both gateway and engine are down', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          status: 'offline',
          status_label: '❌ Offline',
          gateway_reachable: false,
          gateway_port: null,
          engine_ib_connected: false,
          updated_at: new Date().toISOString(),
          is_stale: false,
          session_state: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as typeof fetch;

    const client = new AlgoTraderGatewayClient('http://127.0.0.1:8787');
    const result = await client.getStatus();

    expect(result.data).toMatchObject({
      broker_state: 'unreachable',
      broker_state_authoritative: true,
      gateway_reachable: false,
      engine_ib_connected: false,
    });
    expect(String(result.data.operator_guidance)).toContain('unreachable');
  });

  test('getStatus returns unknown broker state when status is stale', async () => {
    const staleTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          status: 'stale',
          status_label: '⏳ Stale',
          gateway_reachable: true,
          gateway_port: 4002,
          engine_ib_connected: true,
          updated_at: staleTimestamp,
          is_stale: true,
          session_state: 'LIVE',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as typeof fetch;

    const client = new AlgoTraderGatewayClient('http://127.0.0.1:8787');
    const result = await client.getStatus();

    expect(result.stale).toBe(true);
    expect(result.data).toMatchObject({
      broker_state: 'unknown',
      broker_state_authoritative: false,
    });
    expect(String(result.data.operator_guidance)).toContain('stale');
  });

  test('getStatus reports non-default gateway port in guidance', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          status: 'online',
          status_label: '✅ Online (port 7496)',
          gateway_reachable: true,
          gateway_port: 7496,
          engine_ib_connected: true,
          updated_at: new Date().toISOString(),
          is_stale: false,
          session_state: 'LIVE',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as typeof fetch;

    const client = new AlgoTraderGatewayClient('http://127.0.0.1:8787');
    const result = await client.getStatus();

    expect(result.data.gateway_port).toBe(7496);
    expect(String(result.data.operator_guidance)).toContain('7496');
  });
});
