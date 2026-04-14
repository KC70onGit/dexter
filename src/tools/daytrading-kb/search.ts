import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { searchDayTradingKb } from './repository.js';

export const DAYTRADING_KB_SEARCH_DESCRIPTION = `
Search the local r/Daytrading knowledge base stored on disk.

## When to Use

- When the user asks Dexter to research the daytrading wiki or day trading education material
- When you need local KB results before falling back to web search
- For questions about trading basics, psychology, risk management, brokers, workflow, or trading education material

## When NOT to Use

- For live market state or current AlgoTrader runtime questions
- For general web questions that are not about the local daytrading KB
- When you already have the exact local KB path and should read it directly

## Usage Notes

- Searches the local SQLite FTS index under \`a_llm_wiki/daytrading_kb/\`
- Returns local paths, snippets, source URLs, and source types
- Default behavior excludes docs currently marked unavailable
- Best paired with \`daytrading_kb_read\` to inspect the winning local documents
`.trim();

const searchSchema = z.object({
  query: z.string().describe('The KB search query to run'),
  limit: z
    .number()
    .optional()
    .describe('Maximum number of results to return (default 5, capped at 10)'),
  source_type: z
    .enum(['any', 'reddit_wiki', 'reddit_post'])
    .optional()
    .describe('Optional source-type filter'),
  include_unavailable: z
    .boolean()
    .optional()
    .describe('Include documents currently marked unavailable'),
});

export const dayTradingKbSearchTool = new DynamicStructuredTool({
  name: 'daytrading_kb_search',
  description:
    'Search the local r/Daytrading KB and return matching local documents with snippets and paths.',
  schema: searchSchema,
  func: async (input) => {
    const results = await searchDayTradingKb({
      query: input.query,
      limit: input.limit,
      sourceType: input.source_type,
      includeUnavailable: input.include_unavailable,
    });
    const urls = results
      .map((row) => row.source_url)
      .filter((url): url is string => Boolean(url));
    return formatToolResult({ results }, urls);
  },
});
