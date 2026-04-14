import matter from 'gray-matter';
import { access, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { formatSize, truncateHead } from '../filesystem/utils/truncate.js';

export const DEFAULT_INTERNAL_WIKI_ROOT =
  '/Users/keespronk/Python_Dev/a_llm_wiki/wiki';

export interface InternalWikiSearchParams {
  query: string;
  limit?: number;
  wikiRoot?: string;
}

export interface InternalWikiSearchResult {
  title: string;
  path: string;
  absolutePath: string;
  heading: string;
  snippet: string;
  score: number;
}

export interface InternalWikiReadParams {
  path: string;
  offset?: number;
  limit?: number;
  wikiRoot?: string;
}

export interface InternalWikiReadResult {
  path: string;
  absolutePath: string;
  metadata: Record<string, unknown> | null;
  content: string;
  truncated: boolean;
  totalLines: number;
}

interface WikiChunk {
  heading: string;
  content: string;
}

function normalizeSearchLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    return 5;
  }
  return Math.max(1, Math.min(10, Math.trunc(limit)));
}

export function getInternalWikiRoot(): string {
  return process.env.INTERNAL_WIKI_ROOT || DEFAULT_INTERNAL_WIKI_ROOT;
}

function resolveWikiPath(filePath: string, wikiRoot: string): string {
  const root = resolve(wikiRoot);
  const candidate = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || (rel === '' && candidate !== root) || isAbsolute(rel)) {
    throw new Error(`Path escapes internal wiki root: ${filePath}`);
  }
  return candidate;
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => resolve(root, entry.name))
    .sort();
}

function splitMarkdownChunks(content: string): WikiChunk[] {
  const lines = content.split('\n');
  const chunks: WikiChunk[] = [];
  let currentHeading = '(document)';
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (!text) {
      return;
    }
    chunks.push({ heading: currentHeading, content: text });
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2].trim() || '(document)';
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (chunks.length === 0) {
    const text = content.trim();
    if (text) {
      chunks.push({ heading: '(document)', content: text });
    }
  }

  return chunks;
}

function tokenizeQuery(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function scoreChunk(title: string, heading: string, content: string, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }

  const titleLower = title.toLowerCase();
  const headingLower = heading.toLowerCase();
  const contentLower = content.toLowerCase();
  const tokens = tokenizeQuery(normalizedQuery);

  let score = 0;
  if (titleLower.includes(normalizedQuery)) {
    score += 10;
  }
  if (headingLower.includes(normalizedQuery)) {
    score += 8;
  }
  if (contentLower.includes(normalizedQuery)) {
    score += 5;
  }

  for (const token of tokens) {
    if (titleLower.includes(token)) {
      score += 4;
    }
    if (headingLower.includes(token)) {
      score += 3;
    }
    if (contentLower.includes(token)) {
      score += 1;
    }
  }

  return score;
}

function buildSnippet(content: string, query: string): string {
  const flattened = collapseWhitespace(content);
  if (flattened.length <= 240) {
    return flattened;
  }

  const lower = flattened.toLowerCase();
  const queryLower = query.trim().toLowerCase();
  const index = queryLower ? lower.indexOf(queryLower) : -1;
  if (index < 0) {
    return `${flattened.slice(0, 237).trimEnd()}...`;
  }

  const start = Math.max(0, index - 80);
  const end = Math.min(flattened.length, index + 160);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < flattened.length ? '...' : '';
  return `${prefix}${flattened.slice(start, end).trim()}${suffix}`;
}

export async function searchInternalWiki(
  params: InternalWikiSearchParams,
): Promise<InternalWikiSearchResult[]> {
  const wikiRoot = params.wikiRoot || getInternalWikiRoot();
  const files = await listMarkdownFiles(wikiRoot);
  const query = params.query.trim();
  const limit = normalizeSearchLimit(params.limit);

  const results: InternalWikiSearchResult[] = [];
  for (const absolutePath of files) {
    const rawText = (await readFile(absolutePath)).toString('utf-8');
    const parsed = matter(rawText);
    const content = parsed.content || rawText;
    const title =
      typeof parsed.data.title === 'string' && parsed.data.title.trim()
        ? parsed.data.title.trim()
        : absolutePath.split('/').pop()?.replace(/\.md$/, '') || absolutePath;

    for (const chunk of splitMarkdownChunks(content)) {
      const score = scoreChunk(title, chunk.heading, chunk.content, query);
      if (score <= 0) {
        continue;
      }
      results.push({
        title,
        path: relative(resolve(wikiRoot), absolutePath) || '.',
        absolutePath,
        heading: chunk.heading,
        snippet: buildSnippet(chunk.content, query),
        score,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.heading.localeCompare(b.heading))
    .slice(0, limit);
}

export async function readInternalWikiDocument(
  params: InternalWikiReadParams,
): Promise<InternalWikiReadResult> {
  const wikiRoot = params.wikiRoot || getInternalWikiRoot();
  const absolutePath = resolveWikiPath(params.path, wikiRoot);

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
    path: relative(resolve(wikiRoot), absolutePath) || '.',
    absolutePath,
    metadata: hasFrontmatter ? parsed.data : null,
    content: outputText,
    truncated: truncation.truncated,
    totalLines,
  };
}
