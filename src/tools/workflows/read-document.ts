import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { readWorkflowDocument } from './repository.js';

export const WORKFLOW_READ_DESCRIPTION = `
Read a local workflow Markdown document from \`.agents/workflows/\`.

## When to Use

- When the user wants the exact steps or commands in a workflow
- After \`workflow_list\` identifies the file you need
- Before starting a workflow so you can confirm its intended behavior

## When NOT to Use

- For internal wiki docs outside the workflow tree
- For arbitrary local files that are not workflows

## Usage Notes

- Accepts a workflow-relative or absolute path under \`.agents/workflows/\`
- Returns the parsed frontmatter metadata plus full Markdown content
`.trim();

const readSchema = z.object({
  path: z.string().describe('Workflow path to read, relative to .agents/workflows/ or absolute within that root.'),
});

export const workflowReadTool = new DynamicStructuredTool({
  name: 'workflow_read',
  description: 'Read a local workflow Markdown file from the workflows directory.',
  schema: readSchema,
  func: async (input) => {
    const document = await readWorkflowDocument({ path: input.path });
    return formatToolResult(document);
  },
});
