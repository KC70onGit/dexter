import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { searchInternalWiki } from './repository.js';

export const INTERNAL_WIKI_SEARCH_DESCRIPTION = `
Search the local internal engineering wiki stored on disk.

## When to Use

- When the user asks Dexter about project architecture, status, runbooks, config, or internal design docs
- When you want internal wiki context before broader codebase exploration
- For questions about system overview, operators, reconnect logic, backtesting tiers, or decision history

## When NOT to Use

- For the external trading education KB under \`a_llm_wiki/daytrading_kb/\`
- For live market state or current AlgoTrader runtime questions
- When you already have the exact wiki file path and should read it directly

## Usage Notes

- Searches markdown files under \`a_llm_wiki/wiki/\`
- Returns ranked results with local paths, headings, and snippets
- Best paired with \`internal_wiki_read\` to inspect the winning documents
`.trim();

const searchSchema = z.object({
  query: z.string().describe('The internal wiki search query to run'),
  limit: z
    .number()
    .optional()
    .describe('Maximum number of results to return (default 5, capped at 10)'),
});

export const internalWikiSearchTool = new DynamicStructuredTool({
  name: 'internal_wiki_search',
  description:
    'Search the local internal engineering wiki and return matching documents with snippets and paths.',
  schema: searchSchema,
  func: async (input) => {
    const results = await searchInternalWiki({
      query: input.query,
      limit: input.limit,
    });
    return formatToolResult({ results });
  },
});
