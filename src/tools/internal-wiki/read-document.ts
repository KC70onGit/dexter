import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { readInternalWikiDocument } from './repository.js';

export const INTERNAL_WIKI_READ_DESCRIPTION = `
Read a local file from the internal engineering wiki subtree.

## When to Use

- After \`internal_wiki_search\` identifies relevant local documents
- To open files under \`a_llm_wiki/wiki/\`
- To inspect project runbooks, architecture notes, and internal reference material

## When NOT to Use

- For the external trading education KB under \`a_llm_wiki/daytrading_kb/\`
- For general workspace files outside the internal wiki (use \`read_file\`)
- For web pages or live URLs (use \`web_fetch\` or \`browser\`)

## Usage Notes

- Accepts a path relative to the wiki root, such as \`index.md\` or \`operator-runbook.md\`
- Also accepts a fully qualified path under the internal wiki root
- Returns parsed frontmatter metadata when present plus paginated content
`.trim();

const readSchema = z.object({
  path: z
    .string()
    .describe('Path relative to the internal wiki root, e.g. operator-runbook.md'),
  offset: z
    .number()
    .optional()
    .describe('1-indexed line offset to start reading from'),
  limit: z
    .number()
    .optional()
    .describe('Maximum number of lines to read from the offset'),
});

export const internalWikiReadTool = new DynamicStructuredTool({
  name: 'internal_wiki_read',
  description:
    'Read a local document from the internal engineering wiki by path.',
  schema: readSchema,
  func: async (input) => {
    const result = await readInternalWikiDocument({
      path: input.path,
      offset: input.offset,
      limit: input.limit,
    });
    return formatToolResult(result);
  },
});
