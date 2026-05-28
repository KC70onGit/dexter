import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TradeIdeasHubClient } from './client.js';

const realFetch = globalThis.fetch;

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TRADE_IDEAS_HUB_BASE_URL;
  delete process.env.ALGOTRADER_REPO_ROOT;
});

describe('TradeIdeasHubClient', () => {
  test('reads integrated universe from Hub API and returns a bounded summary', async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      seenUrls.push(inputUrl(input));
      return new Response(
        JSON.stringify({
          generated_at: '2026-05-28T12:00:00Z',
          rows: [
            { ticker: 'NVDA', integrated_score: 98.2, verdict: 'PASS' },
            { ticker: 'MSFT', integrated_score: 91.4, verdict: 'PASS' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const client = new TradeIdeasHubClient({
      baseUrl: 'http://127.0.0.1:8811',
      repoRoot: '/unused',
    });

    const result = await client.getIntegratedUniverse();

    expect(seenUrls).toEqual(['http://127.0.0.1:8811/api/integrated-pipeline?rerank_legacy=0']);
    expect(result.source).toBe('hub_api');
    expect(result.data_contract).toBe('integrated_universe');
    expect(result.summary.total_rows).toBe(2);
    expect(result.summary.top_tickers).toEqual(['NVDA', 'MSFT']);
    expect(result.rows).toHaveLength(2);
  });

  test('falls back to latest integrated universe artifact when Hub API is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trade-ideas-hub-'));
    try {
      await mkdir(join(root, 'analysers', 'universes'), { recursive: true });
      await writeFile(
        join(root, 'analysers', 'universes', '2026-05-28_integrated_scored_universe.json'),
        JSON.stringify({
          candidates: [
            { ticker: 'AAPL', integrated_score: 88.1 },
            { ticker: 'TSLA', integrated_score: 70.5 },
          ],
        }),
      );
      globalThis.fetch = (async () => {
        throw new Error('Hub offline');
      }) as unknown as typeof fetch;

      const client = new TradeIdeasHubClient({
        baseUrl: 'http://127.0.0.1:8811',
        repoRoot: root,
      });

      const result = await client.getIntegratedUniverse();

      expect(result.source).toBe('local_artifact_fallback');
      expect(result.fallback_reason).toContain('Hub offline');
      expect(result.paths[0]).toContain('2026-05-28_integrated_scored_universe.json');
      expect(result.summary.total_rows).toBe(2);
      expect(result.summary.top_tickers).toEqual(['AAPL', 'TSLA']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('quality assurance fallback reads runtime QA and latest validation evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trade-ideas-qa-'));
    try {
      await mkdir(join(root, 'algotrader', 'runtime'), { recursive: true });
      await mkdir(join(root, 'analysers', 'eod_preopen_validations'), { recursive: true });
      await writeFile(
        join(root, 'algotrader', 'runtime', 'quality_assurance_state.json'),
        JSON.stringify({ status: 'PASS', checks: [{ name: 'pipeline', status: 'PASS' }] }),
      );
      await writeFile(
        join(root, 'analysers', 'eod_preopen_validations', '2026-05-28_eod_preopen_plan_validation.json'),
        JSON.stringify({ quality_assurance: { status: 'FAIL', checks: [{ name: 'validation', status: 'FAIL' }] } }),
      );
      globalThis.fetch = (async () => new Response('{"available": false, "error": "down"}', { status: 500 })) as unknown as typeof fetch;

      const client = new TradeIdeasHubClient({
        baseUrl: 'http://127.0.0.1:8811',
        repoRoot: root,
      });

      const result = await client.getQualityAssurance();

      expect(result.source).toBe('local_artifact_fallback');
      expect(result.data_contract).toBe('quality_assurance');
      expect(result.paths).toHaveLength(2);
      expect(result.summary.status).toBe('FAIL');
      expect(result.summary.check_counts).toEqual({ PASS: 1, FAIL: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reads quality-assurance checks from Hub API sections', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: 'FAIL',
          generated_at: '2026-05-28T12:00:00Z',
          sections: [
            { title: 'Daily pipeline', checks: [{ name: 'daily', status: 'PASS' }] },
            { title: 'Runtime quality', checks: [{ name: 'runtime', status: 'FAIL' }] },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const client = new TradeIdeasHubClient({
      baseUrl: 'http://127.0.0.1:8811',
      repoRoot: '/unused',
    });

    const result = await client.getQualityAssurance();

    expect(result.source).toBe('hub_api');
    expect(result.summary.status).toBe('FAIL');
    expect(result.summary.total_rows).toBe(2);
    expect(result.summary.check_counts).toEqual({ PASS: 1, FAIL: 1 });
    expect(result.rows).toHaveLength(2);
  });

  test('opening-session fallback ignores unrelated runtime JSON files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trade-ideas-opening-'));
    try {
      await mkdir(join(root, 'algotrader', 'runtime'), { recursive: true });
      await writeFile(
        join(root, 'algotrader', 'runtime', 'state.json'),
        JSON.stringify({ rows: [{ ticker: 'BAD' }] }),
      );
      await writeFile(
        join(root, 'algotrader', 'runtime', 'daily_opening_readiness_manifest_2026-05-28.json'),
        JSON.stringify({
          status: 'WARN',
          rows: [{ ticker: 'GOOD', preopen_state: 'waiting_for_phase' }],
        }),
      );
      globalThis.fetch = (async () => {
        throw new Error('Hub offline');
      }) as unknown as typeof fetch;

      const client = new TradeIdeasHubClient({
        baseUrl: 'http://127.0.0.1:8811',
        repoRoot: root,
      });

      const result = await client.getOpeningSession({ date: '2026-05-28' });

      expect(result.source).toBe('local_artifact_fallback');
      expect(result.paths).toHaveLength(1);
      expect(result.paths[0]).toContain('daily_opening_readiness_manifest_2026-05-28.json');
      expect(result.paths[0]).not.toContain('state.json');
      expect(result.summary.top_tickers).toEqual(['GOOD']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reads watchlist tile items and unique ticker summary from Hub API', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          available: true,
          generated_at: '2026-05-28T12:00:00Z',
          summary: {
            tile_count: 1,
            total_unique_tickers: 2,
          },
          tiles: [
            {
              id: 'universe_watch',
              title: 'Universe Watch',
              available: true,
              items: [
                { ticker: 'NVDA', status: 'watch' },
                { ticker: 'MSFT', status: 'watch' },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const client = new TradeIdeasHubClient({
      baseUrl: 'http://127.0.0.1:8811',
      repoRoot: '/unused',
    });

    const result = await client.getWatchlists();

    expect(result.source).toBe('hub_api');
    expect(result.status).toBe('AVAILABLE');
    expect(result.summary.total_rows).toBe(2);
    expect(result.summary.top_tickers).toEqual(['NVDA', 'MSFT']);
    expect(result.rows).toHaveLength(2);
  });
});
