import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { TradeIdeasHubClient } from './client.js';

export const TRADE_IDEAS_INTEGRATED_UNIVERSE_DESCRIPTION = `
Read the Trade Ideas Hub integrated ticker universe.

Use this when the user asks about Dexter's integrated universe, ranked candidates,
source mix, candidate quality, or which tickers are in the current daily idea set.
Reads the Hub API first and falls back to canonical local artifacts when the Hub is offline.

This is read-only. It does not run scanners, call IBKR, or mutate artifacts.
`.trim();

export function createTradeIdeasIntegratedUniverseTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'trade_ideas_integrated_universe',
    description: TRADE_IDEAS_INTEGRATED_UNIVERSE_DESCRIPTION,
    schema: z.object({
      date: z.string().optional().describe('Optional YYYY-MM-DD artifact date for local fallback.'),
    }),
    func: async ({ date }) => {
      const client = new TradeIdeasHubClient();
      const result = await client.getIntegratedUniverse({ date });
      return formatToolResult(result);
    },
  });
}
