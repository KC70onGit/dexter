import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readDayTradingKbDocument,
  searchDayTradingKb,
} from './repository.js';

const cleanupDirs: string[] = [];

afterEach(async () => {
  delete process.env.DAYTRADING_KB_ROOT;
  delete process.env.DAYTRADING_KB_DB_PATH;
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createFixtureKb(): Promise<{
  kbRoot: string;
  dbPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'daytrading-kb-'));
  cleanupDirs.push(root);
  const kbRoot = join(root, 'a_llm_wiki', 'daytrading_kb');
  const dbPath = join(kbRoot, 'index', 'daytrading_kb.db');
  await mkdir(join(kbRoot, 'index'), { recursive: true });
  await mkdir(join(kbRoot, 'wiki'), { recursive: true });
  await mkdir(join(kbRoot, 'normalized', 'reddit', 'daytrading', 'posts'), {
    recursive: true,
  });

  const sqlite = await import('bun:sqlite');
  const Database = sqlite.Database;
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE VIRTUAL TABLE chunk_fts USING fts5(title, heading, content, content='');
      CREATE TABLE documents (
        document_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        source_url TEXT NOT NULL,
        status TEXT NOT NULL,
        current_version_id TEXT NOT NULL,
        current_path TEXT NOT NULL
      );
      CREATE TABLE chunks (
        chunk_id INTEGER PRIMARY KEY,
        document_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        title TEXT NOT NULL,
        heading TEXT NOT NULL,
        heading_path TEXT NOT NULL,
        content TEXT NOT NULL,
        local_path TEXT NOT NULL,
        source_type TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        source_url TEXT NOT NULL
      );
    `);

    db.prepare(
      `INSERT INTO documents (
        document_id, source_type, title, author, source_url, status, current_version_id, current_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'reddit_post:otpd7a',
      'reddit_post',
      'Understanding and Figuring Out Relative Strength',
      'hari',
      'https://www.reddit.com/r/Daytrading/comments/otpd7a/understanding_and_figuring_out_relative_strength/',
      'active',
      'ver1',
      'normalized/reddit/daytrading/posts/otpd7a.md',
    );

    db.prepare(
      `INSERT INTO documents (
        document_id, source_type, title, author, source_url, status, current_version_id, current_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'reddit_post:block1',
      'reddit_post',
      'Blocked Doc',
      null,
      'https://www.reddit.com/r/Daytrading/comments/block1/blocked/',
      'unavailable',
      'ver2',
      'normalized/reddit/daytrading/posts/block1.md',
    );

    db.prepare(
      `INSERT INTO chunks (
        chunk_id, document_id, version_id, title, heading, heading_path, content, local_path, source_type, fetched_at, source_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      'reddit_post:otpd7a',
      'ver1',
      'Understanding and Figuring Out Relative Strength',
      '(document)',
      '(document)',
      'Relative strength versus SPY is the core method for day trading.',
      'normalized/reddit/daytrading/posts/otpd7a.md',
      'reddit_post',
      '2026-04-14T16:56:02.394659Z',
      'https://www.reddit.com/r/Daytrading/comments/otpd7a/understanding_and_figuring_out_relative_strength/',
    );
    db.prepare(
      `INSERT INTO chunk_fts (rowid, title, heading, content) VALUES (?, ?, ?, ?)`,
    ).run(
      1,
      'Understanding and Figuring Out Relative Strength',
      '(document)',
      'Relative strength versus SPY is the core method for day trading.',
    );

    db.prepare(
      `INSERT INTO chunks (
        chunk_id, document_id, version_id, title, heading, heading_path, content, local_path, source_type, fetched_at, source_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      2,
      'reddit_post:block1',
      'ver2',
      'Blocked Doc',
      '(document)',
      '(document)',
      'Relative strength blocked result',
      'normalized/reddit/daytrading/posts/block1.md',
      'reddit_post',
      '2026-04-14T17:00:00.000000Z',
      'https://www.reddit.com/r/Daytrading/comments/block1/blocked/',
    );
    db.prepare(
      `INSERT INTO chunk_fts (rowid, title, heading, content) VALUES (?, ?, ?, ?)`,
    ).run(2, 'Blocked Doc', '(document)', 'Relative strength blocked result');
  } finally {
    db.close();
  }

  await writeFile(
    join(kbRoot, 'wiki', 'getting-started.md'),
    '# Getting Started\n\nUse risk management and discipline.\n',
    'utf-8',
  );
  await writeFile(
    join(kbRoot, 'normalized', 'reddit', 'daytrading', 'posts', 'otpd7a.md'),
    `---
document_id: reddit_post:otpd7a
source_type: reddit_post
source_url: https://www.reddit.com/r/Daytrading/comments/otpd7a/understanding_and_figuring_out_relative_strength/
title: Understanding and Figuring Out Relative Strength
---

Relative strength versus SPY is the core method for day trading.
`,
    'utf-8',
  );

  return { kbRoot, dbPath };
}

describe('daytrading-kb repository', () => {
  test('searches the local KB and excludes unavailable docs by default', async () => {
    const { dbPath } = await createFixtureKb();

    const results = await searchDayTradingKb({
      query: 'relative strength',
      dbPath,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'Understanding and Figuring Out Relative Strength',
      local_path: 'normalized/reddit/daytrading/posts/otpd7a.md',
      status: 'active',
    });
    expect(results[0]?.snippet).toContain('Relative strength versus SPY');
  });

  test('reads curated and normalized KB files within the KB root', async () => {
    const { kbRoot } = await createFixtureKb();

    const curated = await readDayTradingKbDocument({
      path: 'wiki/getting-started.md',
      kbRoot,
    });
    expect(curated.metadata).toBeNull();
    expect(curated.content).toContain('risk management and discipline');

    const normalized = await readDayTradingKbDocument({
      path: 'normalized/reddit/daytrading/posts/otpd7a.md',
      kbRoot,
    });
    expect(normalized.metadata).toBeTruthy();
    expect(String(normalized.metadata?.title)).toBe(
      'Understanding and Figuring Out Relative Strength',
    );
    expect(normalized.content).toContain('Relative strength versus SPY');
  });

  test('rejects paths that escape the KB root', async () => {
    const { kbRoot } = await createFixtureKb();

    await expect(
      readDayTradingKbDocument({
        path: '../outside.md',
        kbRoot,
      }),
    ).rejects.toThrow('Path escapes DayTrading KB root');
  });
});
