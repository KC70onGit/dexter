import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type TradeIdeasDataContract =
  | 'integrated_universe'
  | 'quality_assurance'
  | 'opening_session'
  | 'watchlists';

export type TradeIdeasHubSource = 'hub_api' | 'local_artifact_fallback';

export type TradeIdeasHubResult = {
  source: TradeIdeasHubSource;
  data_contract: TradeIdeasDataContract;
  status: string;
  updated_at: string | null;
  stale: boolean;
  summary: Record<string, unknown>;
  rows: unknown[];
  paths: string[];
  data: unknown;
  fallback_reason?: string;
};

type ClientOptions = {
  baseUrl?: string;
  repoRoot?: string;
  timeoutMs?: number;
};

type ArtifactSpec = {
  dir: string;
  prefix?: string;
  suffix: string;
};

const DEFAULT_BASE_URL = process.env.TRADE_IDEAS_HUB_BASE_URL?.trim() || 'http://127.0.0.1:8811';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_ROWS = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function defaultRepoRoot(): string {
  return process.env.ALGOTRADER_REPO_ROOT?.trim() || join(process.cwd(), '..');
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Trade Ideas Hub returned non-JSON from ${response.url}`);
  }
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function firstArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function qualityAssurance(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.quality_assurance)) return payload.quality_assurance;
  return null;
}

function sectionChecks(payload: Record<string, unknown>): unknown[] {
  if (!Array.isArray(payload.sections)) return [];
  return payload.sections.flatMap((section) => {
    if (!isRecord(section)) return [];
    return firstArray(section, ['checks']);
  });
}

function watchlistItems(payload: Record<string, unknown>): unknown[] {
  const directRows = firstArray(payload, ['rows', 'watchlists', 'items', 'tickers']);
  const tileRows = Array.isArray(payload.tiles)
    ? payload.tiles.flatMap((tile) => {
      if (!isRecord(tile)) return [];
      return firstArray(tile, ['items']);
    })
    : [];
  return directRows.concat(tileRows);
}

function extractRows(payload: unknown, contract: TradeIdeasDataContract): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  if (Array.isArray(payload.artifacts)) {
    return payload.artifacts.flatMap((artifact) => {
      if (!isRecord(artifact)) return [];
      return extractRows(artifact.data, contract);
    });
  }

  if (contract === 'integrated_universe') {
    return firstArray(payload, ['ranked_candidates', 'rows', 'candidates', 'analysis', 'data']);
  }
  if (contract === 'quality_assurance') {
    const qa = qualityAssurance(payload);
    return firstArray(payload, ['checks', 'rows'])
      .concat(qa ? firstArray(qa, ['checks']) : [])
      .concat(sectionChecks(payload));
  }
  if (contract === 'opening_session') {
    return firstArray(payload, ['rows', 'analysis', 'candidates', 'opening_session']);
  }
  return watchlistItems(payload);
}

function extractTicker(row: unknown): string | null {
  if (!isRecord(row)) return null;
  const ticker = row.ticker ?? row.symbol;
  return typeof ticker === 'string' && ticker.trim() ? ticker.trim().toUpperCase() : null;
}

function countStatuses(rows: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const rawStatus = row.status ?? row.state ?? row.preopen_state;
    if (typeof rawStatus !== 'string' || !rawStatus.trim()) continue;
    const status = rawStatus.trim().toUpperCase();
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function statusSeverity(status: string): number {
  switch (status.toUpperCase()) {
    case 'FAIL':
    case 'ERROR':
    case 'UNAVAILABLE':
      return 4;
    case 'WARN':
    case 'WARNING':
      return 3;
    case 'AVAILABLE':
      return 2;
    case 'PASS':
    case 'OK':
      return 1;
    default:
      return 0;
  }
}

function worstStatus(statuses: string[]): string | null {
  const ranked = statuses
    .map((status) => status.toUpperCase())
    .filter((status) => status !== 'UNKNOWN')
    .sort((a, b) => statusSeverity(b) - statusSeverity(a));
  return ranked[0] ?? null;
}

function collectPaths(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const paths = [
    payload.canonical_artifact_path,
    payload.compatibility_artifact_path,
  ].filter((path): path is string => typeof path === 'string' && path.length > 0);
  const sourceArtifacts = payload.source_artifacts;
  if (Array.isArray(sourceArtifacts)) {
    for (const artifact of sourceArtifacts) {
      if (isRecord(artifact) && typeof artifact.path === 'string' && artifact.path.trim()) {
        paths.push(artifact.path.trim());
      }
    }
  }
  return [...new Set(paths)];
}

function statusOf(payload: unknown, rows: unknown[]): string {
  if (isRecord(payload)) {
    if (Array.isArray(payload.artifacts)) {
      const artifactStatuses: string[] = [];
      for (const artifact of payload.artifacts) {
        if (!isRecord(artifact)) continue;
        const artifactStatus = statusOf(artifact.data, []);
        if (artifactStatus !== 'UNKNOWN') artifactStatuses.push(artifactStatus);
      }
      const status = worstStatus(artifactStatuses);
      if (status) return status;
    }
    const status = pickString(payload, ['status', 'assessment_state']);
    if (status) return status.toUpperCase();
    const qa = qualityAssurance(payload);
    if (qa) {
      const qaStatus = pickString(qa, ['status']);
      if (qaStatus) return qaStatus.toUpperCase();
    }
    if (payload.available === false) return 'UNAVAILABLE';
    if (payload.available === true) return 'AVAILABLE';
  }
  const counts = countStatuses(rows);
  if (Object.keys(counts).length > 0) return 'AVAILABLE';
  return 'UNKNOWN';
}

function updatedAtOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return pickString(payload, ['generated_at', 'updated_at', 'ts_utc', 'as_of']) ?? null;
}

function buildSummary(payload: unknown, contract: TradeIdeasDataContract, rows: unknown[]): Record<string, unknown> {
  const record = isRecord(payload) ? payload : {};
  const qa = qualityAssurance(payload);
  const status = statusOf(payload, rows);
  const watchlistSummary = contract === 'watchlists' && isRecord(record.summary) ? record.summary : null;
  const totalRows =
    pickNumber(record, ['total_count', 'row_count', 'ticker_count'])
    ?? (watchlistSummary ? pickNumber(watchlistSummary, ['total_unique_tickers']) : null)
    ?? rows.length;
  const topTickers = rows.map(extractTicker).filter((ticker): ticker is string => Boolean(ticker)).slice(0, 10);
  const checkRows = contract === 'quality_assurance'
    ? rows
    : qa
      ? firstArray(qa, ['checks'])
      : [];
  const summary: Record<string, unknown> = {
    status,
    total_rows: totalRows,
  };
  if (topTickers.length > 0) summary.top_tickers = topTickers;
  if (checkRows.length > 0) summary.check_counts = countStatuses(checkRows);
  if (isRecord(record.state_counts)) summary.state_counts = record.state_counts;
  if (isRecord(record.summary)) summary.runtime_summary = record.summary;
  if (isRecord(record.operator_summary)) summary.operator_summary = record.operator_summary;
  return summary;
}

function normalizePayload(
  payload: unknown,
  contract: TradeIdeasDataContract,
  source: TradeIdeasHubSource,
  paths: string[] = [],
  fallbackReason?: string,
): TradeIdeasHubResult {
  const rows = extractRows(payload, contract);
  const summary = buildSummary(payload, contract, rows);
  return {
    source,
    data_contract: contract,
    status: String(summary.status ?? 'UNKNOWN'),
    updated_at: updatedAtOf(payload),
    stale: source === 'local_artifact_fallback',
    summary,
    rows: rows.slice(0, MAX_ROWS),
    paths: [...new Set([...paths, ...collectPaths(payload)])],
    data: payload,
    ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
  };
}

async function listFiles(root: string, spec: ArtifactSpec, date?: string): Promise<string[]> {
  const dir = join(root, spec.dir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !spec.prefix || entry.startsWith(spec.prefix))
    .filter((entry) => entry.endsWith(spec.suffix))
    .filter((entry) => !date || entry.startsWith(`${date}_`) || entry.includes(`_${date}`))
    .sort()
    .map((entry) => join(dir, entry));
}

async function readJsonArtifact(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

async function readTextArtifact(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  return {
    path,
    tickers: raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

async function newestExisting(root: string, specs: ArtifactSpec[], date?: string): Promise<string | null> {
  const files = (await Promise.all(specs.map((spec) => listFiles(root, spec, date)))).flat();
  if (files.length === 0) return null;
  const withStats = await Promise.all(
    files.map(async (path) => ({ path, mtimeMs: (await stat(path)).mtimeMs })),
  );
  withStats.sort((a, b) => {
    const nameOrder = basename(b.path).localeCompare(basename(a.path));
    return nameOrder || b.mtimeMs - a.mtimeMs;
  });
  return withStats[0].path;
}

async function readLatestJson(root: string, specs: ArtifactSpec[], date?: string): Promise<{ path: string; data: unknown } | null> {
  const path = await newestExisting(root, specs, date);
  if (!path) return null;
  return { path, data: await readJsonArtifact(path) };
}

async function readLatestJsonArtifacts(
  root: string,
  specs: ArtifactSpec[],
  date?: string,
): Promise<Array<{ path: string; data: unknown }>> {
  const results: Array<{ path: string; data: unknown }> = [];
  for (const spec of specs) {
    const artifact = await readLatestJson(root, [spec], date);
    if (artifact) results.push(artifact);
  }
  return results;
}

export class TradeIdeasHubClient {
  private readonly baseUrl: string;
  private readonly repoRoot: string;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.repoRoot = options.repoRoot ?? defaultRepoRoot();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const payload = await parseJson(response);
      if (!response.ok) {
        const error = isRecord(payload) && typeof payload.error === 'string' ? payload.error : response.statusText;
        throw new Error(`Trade Ideas Hub ${path} failed: ${error}`);
      }
      if (isRecord(payload) && payload.available === false && typeof payload.error === 'string') {
        throw new Error(`Trade Ideas Hub ${path} unavailable: ${payload.error}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Trade Ideas Hub ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getIntegratedUniverse(params: { date?: string } = {}): Promise<TradeIdeasHubResult> {
    try {
      const payload = await this.request('/api/integrated-pipeline?rerank_legacy=0');
      return normalizePayload(payload, 'integrated_universe', 'hub_api');
    } catch (error) {
      const artifact = await readLatestJson(this.repoRoot, [
        { dir: 'analysers/universes', suffix: '_integrated_scored_universe.json' },
        { dir: 'analysers/integrated_pipeline', suffix: '_integrated_daily_universe.json' },
      ], params.date);
      if (!artifact) throw error;
      return normalizePayload(
        artifact.data,
        'integrated_universe',
        'local_artifact_fallback',
        [artifact.path],
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async getQualityAssurance(params: { date?: string } = {}): Promise<TradeIdeasHubResult> {
    try {
      const payload = await this.request('/api/quality-assurance');
      return normalizePayload(payload, 'quality_assurance', 'hub_api');
    } catch (error) {
      const artifacts = await readLatestJsonArtifacts(this.repoRoot, [
        { dir: 'algotrader/runtime', suffix: 'quality_assurance_state.json' },
        { dir: 'analysers/eod_preopen_validations', suffix: '_eod_preopen_plan_validation.json' },
      ], params.date);
      if (artifacts.length === 0) throw error;
      return normalizePayload(
        { artifacts },
        'quality_assurance',
        'local_artifact_fallback',
        artifacts.map((artifact) => artifact.path),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async getOpeningSession(params: { date?: string } = {}): Promise<TradeIdeasHubResult> {
    try {
      const payload = await this.request('/api/opening-session');
      return normalizePayload(payload, 'opening_session', 'hub_api');
    } catch (error) {
      const artifacts = await readLatestJsonArtifacts(this.repoRoot, [
        { dir: 'analysers/universes', suffix: '_opening_session_universe.json' },
        { dir: 'analysers/universes', suffix: '_preopen_selection_snapshot.json' },
        { dir: 'analysers/eod_preopen_validations', suffix: '_eod_preopen_plan_validation.json' },
        { dir: 'algotrader/runtime', prefix: 'daily_opening_readiness_manifest_', suffix: '.json' },
        { dir: 'algotrader/runtime', prefix: 'eod_opening_tick_router_', suffix: '.json' },
        { dir: 'algotrader/runtime', prefix: 'eod_opening_bar_coverage_', suffix: '.json' },
      ], params.date);
      if (artifacts.length === 0) throw error;
      return normalizePayload(
        { artifacts },
        'opening_session',
        'local_artifact_fallback',
        artifacts.map((artifact) => artifact.path),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async getWatchlists(params: { date?: string } = {}): Promise<TradeIdeasHubResult> {
    const query = params.date ? `?date=${encodeURIComponent(params.date)}` : '';
    try {
      const payload = await this.request(`/api/watchlists${query}`);
      return normalizePayload(payload, 'watchlists', 'hub_api');
    } catch (error) {
      const paths = [
        join(this.repoRoot, 'analysers', 'watchlist_bot.txt'),
        join(this.repoRoot, 'analysers', 'watchlist_tv.txt'),
      ];
      const artifacts: Array<{ path: string; data: unknown }> = [];
      for (const path of paths) {
        try {
          artifacts.push({ path, data: await readTextArtifact(path) });
        } catch {
          // Missing optional watchlist files should not hide the usable ones.
        }
      }
      const snapshot = await readLatestJson(this.repoRoot, [
        { dir: 'analysers/universes', suffix: '_preopen_selection_snapshot.json' },
      ], params.date);
      if (snapshot) artifacts.push(snapshot);
      if (artifacts.length === 0) throw error;
      return normalizePayload(
        { artifacts },
        'watchlists',
        'local_artifact_fallback',
        artifacts.map((artifact) => artifact.path),
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
