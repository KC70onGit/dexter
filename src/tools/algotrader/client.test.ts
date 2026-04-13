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
});
