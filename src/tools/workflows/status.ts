import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { getWorkflowRunStatus } from './repository.js';

export const WORKFLOW_STATUS_DESCRIPTION = `
Read the latest status and log tail for a background workflow run started by Dexter.

## When to Use

- After \`workflow_run\` to see if the workflow is still running or has completed
- When the user asks whether a remotely started workflow finished successfully
- To inspect the latest log tail without opening the full log file manually

## When NOT to Use

- Before any workflow run has been started
- For arbitrary process inspection outside Dexter-managed workflow runs

## Usage Notes

- Accepts either a specific \`run_id\` or a \`workflow_id\`
- When only \`workflow_id\` is supplied, Dexter returns the latest known run for that workflow
- Includes a log tail for quick diagnostics
`.trim();

const statusSchema = z
  .object({
    run_id: z.string().optional().describe('Specific workflow run id to inspect.'),
    workflow_id: z.string().optional().describe('Workflow id to inspect the latest run for.'),
    tail_lines: z.number().optional().describe('How many log lines to include (default 40, capped at 120).'),
  })
  .refine((value) => Boolean(value.run_id || value.workflow_id), {
    message: 'Provide run_id or workflow_id.',
  });

export const workflowStatusTool = new DynamicStructuredTool({
  name: 'workflow_status',
  description: 'Inspect a Dexter-started workflow run and return status plus recent log output.',
  schema: statusSchema,
  func: async (input) => {
    const status = await getWorkflowRunStatus({
      runId: input.run_id,
      workflowId: input.workflow_id,
      tailLines: input.tail_lines,
    });
    return formatToolResult(status);
  },
});
