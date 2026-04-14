import matter from 'gray-matter';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { formatSize, truncateHead } from '../filesystem/utils/truncate.js';

export const DEFAULT_DAYTRADING_KB_ROOT =
  '/Users/keespronk/Python_Dev/a_llm_wiki/daytrading_kb';

export type DayTradingKbSourceType = 'reddit_wiki' | 'reddit_post' | 'any';

export interface DayTradingKbSearchParams {
  query: string;
  limit?: number;
  sourceType?: DayTradingKbSourceType;
  includeUnavailable?: boolean;
  dbPath?: string;
}

export interface DayTradingKbSearchResult {
  title: string;
  source_url: string;
  local_path: string;
  heading: string;
  snippet: string;
  source_type: string;
  fetched_at: string;
  status: string;
}

export interface DayTradingKbReadParams {
  path: string;
  offset?: number;
  limit?: number;
  kbRoot?: string;
}

export interface DayTradingKbReadResult {
  path: string;
  absolutePath: string;
  metadata: Record<string, unknown> | null;
  content: string;
  truncated: boolean;
  totalLines: number;
}

interface SqliteQuery<T> {
  all: (...params: unknown[]) => T[];
}

interface SqliteDatabase {
  prepare: (sql: string) => SqliteQuery<DayTradingKbSearchResult>;
  close: () => void;
}

export function getDayTradingKbRoot(): string {
  return process.env.DAYTRADING_KB_ROOT || DEFAULT_DAYTRADING_KB_ROOT;
}

export function getDayTradingKbDbPath(): string {
  return (
    process.env.DAYTRADING_KB_DB_PATH ||
    resolve(getDayTradingKbRoot(), 'index', 'daytrading_kb.db')
  );
}

function resolveKbPath(filePath: string, kbRoot: string): string {
  const root = resolve(kbRoot);
  const candidate = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || rel === '' && candidate !== root || isAbsolute(rel)) {
    throw new Error(`Path escapes DayTrading KB root: ${filePath}`);
  }
  return candidate;
}

function normalizeSearchLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    return 5;
  }
  return Math.max(1, Math.min(10, Math.trunc(limit)));
}

async function openSqlite(path: string): Promise<SqliteDatabase> {
  try {
    const sqlite = await import('bun:sqlite');
    const DatabaseCtor = sqlite.Database as new (dbPath: string, options?: unknown) => {
      query: <T>(sql: string) => SqliteQuery<T>;
      close: () => void;
    };
    const db = new DatabaseCtor(path, { readonly: true });
    return {
      prepare: (sql: string) => db.query<DayTradingKbSearchResult>(sql),
      close: () => db.close(),
    };
  } catch {
    const mod = await import('better-sqlite3');
    const Database = mod.default;
    const raw = new Database(path, { readonly: true });
    return {
      prepare: (sql: string) => {
        const stmt = raw.prepare(sql);
        return {
          all: (...params: unknown[]) =>
            stmt.all(...params) as DayTradingKbSearchResult[],
        };
      },
      close: () => raw.close(),
    };
  }
}

export async function searchDayTradingKb(
  params: DayTradingKbSearchParams,
): Promise<DayTradingKbSearchResult[]> {
  const dbPath = params.dbPath || getDayTradingKbDbPath();
  const limit = normalizeSearchLimit(params.limit);
  const sourceType = params.sourceType || 'any';
  const includeUnavailable = Boolean(params.includeUnavailable);

  const db = await openSqlite(dbPath);
  try {
    const stmt = db.prepare(
      `
        SELECT
          documents.title AS title,
          documents.source_url AS source_url,
          chunks.local_path AS local_path,
          chunks.heading_path AS heading,
          substr(
            replace(replace(chunks.content, char(10), ' '), char(13), ' '),
            1,
            240
          ) AS snippet,
          chunks.source_type AS source_type,
          chunks.fetched_at AS fetched_at,
          documents.status AS status
        FROM chunk_fts
        JOIN chunks ON chunks.chunk_id = chunk_fts.rowid
        JOIN documents ON documents.document_id = chunks.document_id
        WHERE chunk_fts MATCH ?
          AND (? = 'any' OR chunks.source_type = ?)
          AND (? = 1 OR documents.status != 'unavailable')
        ORDER BY bm25(chunk_fts), documents.title
        LIMIT ?
      `,
    );

    return stmt.all(
      params.query,
      sourceType,
      sourceType,
      includeUnavailable ? 1 : 0,
      limit,
    ) as DayTradingKbSearchResult[];
  } finally {
    db.close();
  }
}

export async function readDayTradingKbDocument(
  params: DayTradingKbReadParams,
): Promise<DayTradingKbReadResult> {
  const kbRoot = params.kbRoot || getDayTradingKbRoot();
  const absolutePath = resolveKbPath(params.path, kbRoot);

  await access(absolutePath, constants.R_OK);

  const textContent = (await readFile(absolutePath)).toString('utf-8');
  const parsed = matter(textContent);
  const hasFrontmatter = Object.keys(parsed.data).length > 0;
  const content = hasFrontmatter ? parsed.content : textContent;

  const allLines = content.split('\n');
  const totalLines = allLines.length;
  const startLine = params.offset ? Math.max(0, params.offset - 1) : 0;
  const startLineDisplay = startLine + 1;

  if (startLine >= allLines.length) {
    throw new Error(
      `Offset ${params.offset} is beyond end of file (${allLines.length} lines total)`,
    );
  }

  let selectedContent: string;
  let userLimitedLines: number | undefined;
  if (params.limit !== undefined) {
    const endLine = Math.min(startLine + params.limit, allLines.length);
    selectedContent = allLines.slice(startLine, endLine).join('\n');
    userLimitedLines = endLine - startLine;
  } else {
    selectedContent = allLines.slice(startLine).join('\n');
  }

  const truncation = truncateHead(selectedContent);
  let outputText: string;

  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(
      Buffer.byteLength(allLines[startLine] ?? '', 'utf-8'),
    );
    outputText =
      `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(truncation.maxBytes)} limit.]` +
      ` [Use offset=${startLineDisplay} with a smaller limit to continue.]`;
  } else if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText = truncation.content;
    if (truncation.truncatedBy === 'lines') {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines} (${formatSize(truncation.maxBytes)} limit). Use offset=${nextOffset} to continue.]`;
    }
  } else if (
    userLimitedLines !== undefined &&
    startLine + userLimitedLines < allLines.length
  ) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    outputText = truncation.content;
    outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    outputText = truncation.content;
  }

  return {
    path: relative(resolve(kbRoot), absolutePath) || '.',
    absolutePath,
    metadata: hasFrontmatter ? parsed.data : null,
    content: outputText,
    truncated: truncation.truncated,
    totalLines,
  };
}
