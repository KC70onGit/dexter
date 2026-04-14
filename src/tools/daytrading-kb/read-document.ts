import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { readDayTradingKbDocument } from './repository.js';

export const DAYTRADING_KB_READ_DESCRIPTION = `
Read a local file from the DayTrading KB subtree.

## When to Use

- After \`daytrading_kb_search\` identifies relevant local documents
- To open curated wiki pages under \`a_llm_wiki/daytrading_kb/wiki/\`
- To inspect normalized source documents under \`a_llm_wiki/daytrading_kb/normalized/\`

## When NOT to Use

- For general workspace files in the Dexter repo (use \`read_file\`)
- For web pages or live URLs (use \`web_fetch\` or \`browser\`)
- For broad research before narrowing to a local KB path

## Usage Notes

- Accepts a path relative to the KB root, such as \`wiki/getting-started.md\`
- Also accepts a fully qualified path under the KB root
- Returns parsed frontmatter metadata when present plus paginated content
`.trim();

const readSchema = z.object({
  path: z
    .string()
    .describe('Path relative to the DayTrading KB root, e.g. wiki/getting-started.md'),
  offset: z
    .number()
    .optional()
    .describe('1-indexed line offset to start reading from'),
  limit: z
    .number()
    .optional()
    .describe('Maximum number of lines to read from the offset'),
});

export const dayTradingKbReadTool = new DynamicStructuredTool({
  name: 'daytrading_kb_read',
  description:
    'Read a local document from the DayTrading KB, including curated wiki pages and normalized source docs.',
  schema: readSchema,
  func: async (input) => {
    const result = await readDayTradingKbDocument({
      path: input.path,
      offset: input.offset,
      limit: input.limit,
    });
    const sourceUrl =
      result.metadata &&
      typeof result.metadata.source_url === 'string'
        ? result.metadata.source_url
        : undefined;
    return formatToolResult(result, sourceUrl ? [sourceUrl] : undefined);
  },
});
