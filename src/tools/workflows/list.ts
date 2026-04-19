import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { listWorkflows } from './repository.js';

export const WORKFLOW_LIST_DESCRIPTION = `
List the local Markdown workflow runbooks and show which ones Dexter can start remotely.

## When to Use

- When the user asks what workflows exist under \`.agents/workflows/\`
- When the user wants to find a workflow by name like pre-market scan, watchlist pipeline, or KB maintenance
- Before reading or starting a workflow so you can confirm the exact path and whether it is remotely runnable

## When NOT to Use

- When you already know the exact workflow path and should read it directly
- For arbitrary shell execution; this tool only lists workflow documents

## Usage Notes

- Searches Markdown files under \`.agents/workflows/\`
- Returns local paths, titles, descriptions, and whether the workflow is remotely runnable
- Pair with \`workflow_read\` to inspect the workflow and \`workflow_run\` to start a vetted runnable workflow
`.trim();

const listSchema = z.object({
  query: z.string().optional().describe('Optional substring filter for workflow path, title, or description.'),
  limit: z.number().optional().describe('Maximum number of workflows to return (default 25, capped at 100).'),
  runnable_only: z.boolean().optional().describe('Only return workflows Dexter can start remotely.'),
});

export const workflowListTool = new DynamicStructuredTool({
  name: 'workflow_list',
  description: 'List local workflow runbooks and identify which ones are remotely runnable.',
  schema: listSchema,
  func: async (input) => {
    const workflows = await listWorkflows({
      query: input.query,
      limit: input.limit,
      runnableOnly: input.runnable_only,
    });
    return formatToolResult({ workflows });
  },
});
