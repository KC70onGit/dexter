import { afterEach, describe, expect, test } from 'bun:test';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getWorkflowRunStatus,
  listWorkflows,
  readWorkflowDocument,
  startWorkflowRun,
} from './repository.js';

const cleanupDirs: string[] = [];

afterEach(async () => {
  delete process.env.DEXTER_WORKFLOW_ROOT;
  delete process.env.DEXTER_WORKFLOW_STATE_ROOT;
  delete process.env.DEXTER_WORKFLOW_WORKSPACE_ROOT;
  delete process.env.DEXTER_WORKFLOW_SCAN_PREMARKET_COMMAND;

  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createFixtureEnvironment(): Promise<{
  workflowRoot: string;
  stateRoot: string;
  workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'dexter-workflows-'));
  cleanupDirs.push(root);

  const workflowRoot = join(root, '.agents', 'workflows');
  const stateRoot = join(root, '.dexter', 'workflow-runs');
  const workspaceRoot = join(root, 'workspace');

  await mkdir(workflowRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  await writeFile(
    join(workflowRoot, '3.scan-premarket-live.md'),
    `---
description: Run the pre-market scanner.
---

# Pre-Market Live Scan

Run the sweep and full analyser refresh.
`,
    'utf-8',
  );

  await writeFile(
    join(workflowRoot, 'other.md'),
    `# Other Workflow

Not remotely runnable.
`,
    'utf-8',
  );

  process.env.DEXTER_WORKFLOW_ROOT = workflowRoot;
  process.env.DEXTER_WORKFLOW_STATE_ROOT = stateRoot;
  process.env.DEXTER_WORKFLOW_WORKSPACE_ROOT = workspaceRoot;

  return { workflowRoot, stateRoot, workspaceRoot };
}

async function waitForCompletion(runId: string, retries = 30): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const status = await getWorkflowRunStatus({ runId, tailLines: 20 });
    if (status.status !== 'running') {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Workflow run did not finish in time: ${runId}`);
}

describe('workflow repository', () => {
  test('lists workflows and marks remotely runnable entries', async () => {
    await createFixtureEnvironment();

    const workflows = await listWorkflows({ limit: 10 });

    expect(workflows).toHaveLength(2);
    expect(workflows[0]).toMatchObject({
      path: '3.scan-premarket-live.md',
      remotelyRunnable: true,
      runnableId: 'scan_premarket_live',
    });
    expect(workflows[1]).toMatchObject({
      path: 'other.md',
      remotelyRunnable: false,
      runnableId: null,
    });
  });

  test('reads workflow documents inside the workflow root', async () => {
    await createFixtureEnvironment();

    const document = await readWorkflowDocument({
      path: '3.scan-premarket-live.md',
    });

    expect(document.title).toBe('Pre-Market Live Scan');
    expect(document.description).toContain('pre-market scanner');
    expect(document.content).toContain('Run the sweep');
  });

  test('rejects workflow paths that escape the workflow root', async () => {
    await createFixtureEnvironment();

    await expect(
      readWorkflowDocument({
        path: '../outside.md',
      }),
    ).rejects.toThrow('Path escapes workflow root');
  });

  test('starts and completes a remote workflow run with status tracking', async () => {
    const { stateRoot } = await createFixtureEnvironment();
    process.env.DEXTER_WORKFLOW_SCAN_PREMARKET_COMMAND = 'printf "scan ok\\n"';

    const run = await startWorkflowRun({
      workflowId: 'scan_premarket_live',
    });

    expect(run.workflowId).toBe('scan_premarket_live');
    await waitForCompletion(run.runId);

    const status = await getWorkflowRunStatus({
      runId: run.runId,
      tailLines: 20,
    });

    expect(status.status).toBe('completed');
    expect(status.exitCode).toBe(0);
    expect(status.tail).toContain('scan ok');
    await access(join(stateRoot, `${run.runId}.done.json`), constants.R_OK);
  });

  test('returns failed status and latest-by-workflow lookup for failed runs', async () => {
    const { stateRoot } = await createFixtureEnvironment();
    process.env.DEXTER_WORKFLOW_SCAN_PREMARKET_COMMAND = 'printf "scan fail\\n"; exit 7';

    const run = await startWorkflowRun({
      workflowId: 'scan_premarket_live',
    });

    await waitForCompletion(run.runId);

    const status = await getWorkflowRunStatus({
      workflowId: 'scan_premarket_live',
      tailLines: 20,
    });

    expect(status.runId).toBe(run.runId);
    expect(status.status).toBe('failed');
    expect(status.exitCode).toBe(7);
    expect(status.tail).toContain('scan fail');

    const doneRaw = (await readFile(join(stateRoot, `${run.runId}.done.json`))).toString('utf-8');
    expect(doneRaw).toContain('"exitCode":7');
  });
});
