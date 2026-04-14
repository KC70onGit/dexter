import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readInternalWikiDocument,
  searchInternalWiki,
} from './repository.js';

const cleanupDirs: string[] = [];

afterEach(async () => {
  delete process.env.INTERNAL_WIKI_ROOT;
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createFixtureWiki(): Promise<{ wikiRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'internal-wiki-'));
  cleanupDirs.push(root);
  const wikiRoot = join(root, 'a_llm_wiki', 'wiki');
  await mkdir(wikiRoot, { recursive: true });

  await writeFile(
    join(wikiRoot, 'system-overview.md'),
    `# System Overview

## Runtime

AlgoTrader uses a reconnect manager and startup health checks.

## Deployment

Operators should follow the runbook during restarts.
`,
    'utf-8',
  );

  await writeFile(
    join(wikiRoot, 'operator-runbook.md'),
    `# Operator Runbook

## Startup

Start the gateway, validate health, and confirm reconnect handling.

## Recovery

Use the reconnect checklist before restarting workers.
`,
    'utf-8',
  );

  return { wikiRoot };
}

describe('internal-wiki repository', () => {
  test('searches the internal wiki markdown files', async () => {
    const { wikiRoot } = await createFixtureWiki();

    const results = await searchInternalWiki({
      query: 'reconnect manager',
      wikiRoot,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({
      title: 'system-overview',
      path: 'system-overview.md',
    });
    expect(results[0]?.snippet).toContain('reconnect manager');
  });

  test('reads internal wiki files within the wiki root', async () => {
    const { wikiRoot } = await createFixtureWiki();

    const doc = await readInternalWikiDocument({
      path: 'operator-runbook.md',
      wikiRoot,
    });

    expect(doc.metadata).toBeNull();
    expect(doc.content).toContain('reconnect checklist');
    expect(doc.path).toBe('operator-runbook.md');
  });

  test('rejects paths that escape the internal wiki root', async () => {
    const { wikiRoot } = await createFixtureWiki();

    await expect(
      readInternalWikiDocument({
        path: '../outside.md',
        wikiRoot,
      }),
    ).rejects.toThrow('Path escapes internal wiki root');
  });
});
