import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { startWorkflowRun } from './repository.js';

export const WORKFLOW_RUN_DESCRIPTION = `
Start a vetted local workflow in the background and return a run id plus log path.

## When to Use

- When the user explicitly wants Dexter to start an operational workflow remotely
- For known safe workflows that have been curated into Dexter's runnable allowlist
- When you need a background run id you can monitor later with \`workflow_status\`

## When NOT to Use

- For arbitrary shell execution or free-form command strings
- When the user only wants to inspect or read the workflow
- For workflows Dexter has not been explicitly curated to run yet

## Usage Notes

- This tool is intentionally narrow and only supports a vetted allowlist
- Current supported runnable workflow ids can be discovered through \`workflow_list\`
- Returns immediately after launch; use \`workflow_status\` to monitor progress and logs
`.trim();

const runSchema = z.object({
  workflow_id: z.string().describe('Runnable workflow id, such as scan_premarket_live.'),
});

export const workflowRunTool = new DynamicStructuredTool({
  name: 'workflow_run',
  description: 'Start a vetted local workflow in the background and return its run metadata.',
  schema: runSchema,
  func: async (input) => {
    const run = await startWorkflowRun({
      workflowId: input.workflow_id,
    });
    return formatToolResult(run);
  },
});
