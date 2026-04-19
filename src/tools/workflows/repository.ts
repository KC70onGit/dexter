import matter from 'gray-matter';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const DEFAULT_WORKFLOW_ROOT =
  '/Users/keespronk/Python_Dev/.agents/workflows';

export interface WorkflowSummary {
  path: string;
  absolutePath: string;
  title: string;
  description: string | null;
  remotelyRunnable: boolean;
  runnableId: string | null;
}

export interface WorkflowDocument {
  path: string;
  absolutePath: string;
  title: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  content: string;
}

export type WorkflowRunState = 'running' | 'completed' | 'failed' | 'unknown';

export interface WorkflowRunSummary {
  runId: string;
  workflowId: string;
  workflowPath: string;
  title: string;
  cwd: string;
  status: WorkflowRunState;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  pid: number | null;
  logPath: string;
  tail: string;
}

interface WorkflowRunMetadata {
  runId: string;
  workflowId: string;
  workflowPath: string;
  title: string;
  cwd: string;
  startedAt: string;
  pid: number | null;
  logPath: string;
  donePath: string;
}

interface WorkflowCompletionRecord {
  runId: string;
  workflowId: string;
  finishedAt: string;
  exitCode: number;
}

interface RunnableWorkflowDefinition {
  id: string;
  path: string;
  title: string;
  description: string;
  buildCommand(workspaceRoot: string): string;
}

const RUNNABLE_WORKFLOWS: RunnableWorkflowDefinition[] = [
  {
    id: 'scan_premarket_live',
    path: '3.scan-premarket-live.md',
    title: 'Pre-Market Live Scan',
    description:
      'Run the pre-market sweep, QA filter, and full Master_Analyser grading for early movers.',
    buildCommand(workspaceRoot: string): string {
      const override = process.env.DEXTER_WORKFLOW_SCAN_PREMARKET_COMMAND;
      if (override && override.trim()) {
        return override;
      }

      const root = shellQuote(workspaceRoot);
      return [
        // [FIX-209] Remote workflow execution stays curated and deterministic rather
        // than trusting arbitrary markdown command blocks at runtime.
        `cd ${root}`,
        '.venv/bin/python algotrader/early_premarket_scanner.py',
        '.venv/bin/python analysers/qa_ticker_filter.py --file "scanners (playwright)/bot-premarket-live-watch.txt"',
        '.venv/bin/python analysers/Master_Analyser.py --mode full --source early_premarket',
      ].join('\n');
    },
  },
];

export function getWorkflowRoot(): string {
  return process.env.DEXTER_WORKFLOW_ROOT || DEFAULT_WORKFLOW_ROOT;
}

export function getWorkflowWorkspaceRoot(): string {
  return process.env.DEXTER_WORKFLOW_WORKSPACE_ROOT || '/Users/keespronk/Python_Dev';
}

export function getWorkflowStateRoot(): string {
  return process.env.DEXTER_WORKFLOW_STATE_ROOT || resolve(process.cwd(), '.dexter', 'workflow-runs');
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    return 25;
  }
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function normalizeTailLines(lines: number | undefined): number {
  if (typeof lines !== 'number' || Number.isNaN(lines)) {
    return 40;
  }
  return Math.max(5, Math.min(120, Math.trunc(lines)));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractTitle(content: string, fallbackPath: string): string {
  const headingMatch = content.match(/^#\s+(.*)$/m);
  if (headingMatch?.[1]?.trim()) {
    return headingMatch[1].trim();
  }
  return fallbackPath.split('/').pop()?.replace(/\.md$/i, '') || fallbackPath;
}

function parseWorkflowMarkdown(raw: string): {
  data: Record<string, unknown>;
  content: string;
} {
  try {
    const parsed = matter(raw);
    return {
      data: parsed.data,
      content: parsed.content || raw,
    };
  } catch {
    // [FIX-209] Real workflow notes sometimes carry loose frontmatter-like headers
    // that are not valid YAML, so fall back to raw markdown instead of crashing listing.
    return {
      data: {},
      content: raw,
    };
  }
}

function resolveWorkflowPath(filePath: string, workflowRoot: string): string {
  const root = resolve(workflowRoot);
  const candidate = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes workflow root: ${filePath}`);
  }
  return candidate;
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sorted) {
    const absolute = resolve(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await listMarkdownFiles(absolute)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      output.push(absolute);
    }
  }

  return output;
}

function findRunnableDefinitionForPath(workflowPath: string): RunnableWorkflowDefinition | null {
  const normalized = workflowPath.replace(/\\/g, '/');
  return RUNNABLE_WORKFLOWS.find((item) => item.path === normalized) || null;
}

function findRunnableDefinition(workflowId: string): RunnableWorkflowDefinition | null {
  return (
    RUNNABLE_WORKFLOWS.find(
      (item) => item.id === workflowId || item.path === workflowId || item.title === workflowId,
    ) || null
  );
}

export async function listWorkflows(params: {
  query?: string;
  limit?: number;
  workflowRoot?: string;
  runnableOnly?: boolean;
}): Promise<WorkflowSummary[]> {
  const workflowRoot = params.workflowRoot || getWorkflowRoot();
  const files = await listMarkdownFiles(workflowRoot);
  const query = params.query?.trim().toLowerCase() || '';
  const limit = normalizeLimit(params.limit);
  const runnableOnly = params.runnableOnly === true;

  const summaries: WorkflowSummary[] = [];
  for (const absolutePath of files) {
    const relativePath = relative(resolve(workflowRoot), absolutePath).replace(/\\/g, '/');
    const raw = (await readFile(absolutePath)).toString('utf-8');
    const parsed = parseWorkflowMarkdown(raw);
    const content = parsed.content;
    const title = extractTitle(content, relativePath);
    const description =
      typeof parsed.data.description === 'string' && parsed.data.description.trim()
        ? collapseWhitespace(parsed.data.description)
        : null;
    const runnable = findRunnableDefinitionForPath(relativePath);

    if (runnableOnly && !runnable) {
      continue;
    }

    if (query) {
      const haystack = `${relativePath}\n${title}\n${description || ''}`.toLowerCase();
      if (!haystack.includes(query)) {
        continue;
      }
    }

    summaries.push({
      path: relativePath,
      absolutePath,
      title,
      description,
      remotelyRunnable: Boolean(runnable),
      runnableId: runnable?.id || null,
    });
  }

  return summaries
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, limit);
}

export async function readWorkflowDocument(params: {
  path: string;
  workflowRoot?: string;
}): Promise<WorkflowDocument> {
  const workflowRoot = params.workflowRoot || getWorkflowRoot();
  const absolutePath = resolveWorkflowPath(params.path, workflowRoot);

  await access(absolutePath, constants.R_OK);

  const raw = (await readFile(absolutePath)).toString('utf-8');
  const parsed = parseWorkflowMarkdown(raw);
  const content = parsed.content;
  const hasMetadata = Object.keys(parsed.data).length > 0;

  return {
    path: relative(resolve(workflowRoot), absolutePath).replace(/\\/g, '/'),
    absolutePath,
    title: extractTitle(content, params.path),
    description:
      typeof parsed.data.description === 'string' && parsed.data.description.trim()
        ? collapseWhitespace(parsed.data.description)
        : null,
    metadata: hasMetadata ? parsed.data : null,
    content,
  };
}

function buildRunId(workflowId: string): string {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').replace('Z', '');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${workflowId}_${timestamp}_${suffix}`;
}

function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = (await readFile(filePath)).toString('utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function tailFile(filePath: string, lines: number): Promise<string> {
  try {
    const raw = (await readFile(filePath)).toString('utf-8');
    const chunks = raw.split('\n');
    return chunks.slice(-lines).join('\n').trim();
  } catch {
    return '';
  }
}

function deriveStatus(
  metadata: WorkflowRunMetadata,
  completion: WorkflowCompletionRecord | null,
): WorkflowRunState {
  if (completion) {
    return completion.exitCode === 0 ? 'completed' : 'failed';
  }
  if (isProcessAlive(metadata.pid)) {
    return 'running';
  }
  return 'unknown';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function listRunMetadataFiles(stateRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(stateRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.done.json'))
      .map((entry) => resolve(stateRoot, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function readRunMetadata(runId: string, stateRoot: string): Promise<WorkflowRunMetadata | null> {
  if (!/^[a-z0-9_]+$/i.test(runId)) {
    throw new Error(`Invalid workflow run id: ${runId}`);
  }
  const metadataPath = resolve(stateRoot, `${runId}.json`);
  return readJsonFile<WorkflowRunMetadata>(metadataPath);
}

async function findLatestRunIdForWorkflow(workflowId: string, stateRoot: string): Promise<string | null> {
  const metadataFiles = await listRunMetadataFiles(stateRoot);
  let latest: WorkflowRunMetadata | null = null;

  for (const metadataFile of metadataFiles) {
    const metadata = await readJsonFile<WorkflowRunMetadata>(metadataFile);
    if (!metadata || metadata.workflowId !== workflowId) {
      continue;
    }
    if (!latest || metadata.startedAt > latest.startedAt) {
      latest = metadata;
    }
  }

  return latest?.runId || null;
}

export async function startWorkflowRun(params: {
  workflowId: string;
  workflowRoot?: string;
  workspaceRoot?: string;
  stateRoot?: string;
}): Promise<WorkflowRunSummary> {
  const workflowRoot = params.workflowRoot || getWorkflowRoot();
  const workspaceRoot = params.workspaceRoot || getWorkflowWorkspaceRoot();
  const stateRoot = params.stateRoot || getWorkflowStateRoot();

  const definition = findRunnableDefinition(params.workflowId);
  if (!definition) {
    throw new Error(`Workflow is not remotely runnable: ${params.workflowId}`);
  }

  const workflowAbsolutePath = resolveWorkflowPath(definition.path, workflowRoot);
  await access(workflowAbsolutePath, constants.R_OK);
  await mkdir(stateRoot, { recursive: true });

  const runId = buildRunId(definition.id);
  const startedAt = new Date().toISOString();
  const logPath = resolve(stateRoot, `${runId}.log`);
  const donePath = resolve(stateRoot, `${runId}.done.json`);
  const metadataPath = resolve(stateRoot, `${runId}.json`);
  const command = definition.buildCommand(workspaceRoot);

  await writeFile(
    logPath,
    `[FIX-209] Dexter workflow run ${runId} started ${startedAt}\nWorkflow: ${definition.id}\n\n`,
    'utf-8',
  );

  const wrapperScript = `
set +e
LOG_FILE=${shellQuote(logPath)}
DONE_FILE=${shellQuote(donePath)}
RUN_ID=${shellQuote(runId)}
WORKFLOW_ID=${shellQuote(definition.id)}
(
  echo "[FIX-209] Starting workflow $WORKFLOW_ID ($RUN_ID)"
  set -euo pipefail
${command}
) >> "$LOG_FILE" 2>&1
code=$?
finished_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
printf '{"runId":"%s","workflowId":"%s","finishedAt":"%s","exitCode":%s}\\n' "$RUN_ID" "$WORKFLOW_ID" "$finished_at" "$code" > "$DONE_FILE"
exit 0
`.trim();

  const child = spawn('bash', ['-lc', wrapperScript], {
    cwd: workspaceRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const metadata: WorkflowRunMetadata = {
    runId,
    workflowId: definition.id,
    workflowPath: definition.path,
    title: definition.title,
    cwd: workspaceRoot,
    startedAt,
    pid: child.pid ?? null,
    logPath,
    donePath,
  };
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

  return {
    runId,
    workflowId: definition.id,
    workflowPath: definition.path,
    title: definition.title,
    cwd: workspaceRoot,
    status: 'running',
    startedAt,
    finishedAt: null,
    exitCode: null,
    pid: child.pid ?? null,
    logPath,
    tail: await tailFile(logPath, 40),
  };
}

export async function getWorkflowRunStatus(params: {
  runId?: string;
  workflowId?: string;
  stateRoot?: string;
  tailLines?: number;
}): Promise<WorkflowRunSummary> {
  const stateRoot = params.stateRoot || getWorkflowStateRoot();
  const tailLines = normalizeTailLines(params.tailLines);

  let runId = params.runId?.trim();
  if (!runId) {
    const workflowId = params.workflowId?.trim();
    if (!workflowId) {
      throw new Error('workflow_status requires runId or workflowId');
    }
    runId = (await findLatestRunIdForWorkflow(workflowId, stateRoot)) || undefined;
    if (!runId) {
      throw new Error(`No workflow runs found for: ${workflowId}`);
    }
  }

  const metadata = await readRunMetadata(runId, stateRoot);
  if (!metadata) {
    throw new Error(`Workflow run not found: ${runId}`);
  }

  let completion = await readJsonFile<WorkflowCompletionRecord>(metadata.donePath);
  let status = deriveStatus(metadata, completion);

  // [FIX-209] Detached workflow processes can exit a few milliseconds before the wrapper
  // flushes the completion marker, so re-check once before surfacing a stale "unknown".
  if (status === 'unknown') {
    await delay(150);
    completion = await readJsonFile<WorkflowCompletionRecord>(metadata.donePath);
    status = deriveStatus(metadata, completion);
  }

  return {
    runId: metadata.runId,
    workflowId: metadata.workflowId,
    workflowPath: metadata.workflowPath,
    title: metadata.title,
    cwd: metadata.cwd,
    status,
    startedAt: metadata.startedAt,
    finishedAt: completion?.finishedAt || null,
    exitCode: completion?.exitCode ?? null,
    pid: metadata.pid,
    logPath: metadata.logPath,
    tail: await tailFile(metadata.logPath, tailLines),
  };
}
