import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { TradeIdeasHubClient } from './client.js';

export const TRADE_IDEAS_WATCHLISTS_DESCRIPTION = `
Read Trade Ideas Hub watchlist matrices and exported watchlist artifacts.

Use this when the user asks which watchlists contain a ticker, which generated lists are available,
or what the current bot/TradingView watchlist files contain. Reads the Hub API first and falls
back to read-only local watchlist artifacts.

This never calls brokers or market data providers and does not regenerate watchlists.
`.trim();

export function createTradeIdeasWatchlistsTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'trade_ideas_watchlists',
    description: TRADE_IDEAS_WATCHLISTS_DESCRIPTION,
    schema: z.object({
      date: z.string().optional().describe('Optional YYYY-MM-DD watchlist date.'),
    }),
    func: async ({ date }) => {
      const client = new TradeIdeasHubClient();
      const result = await client.getWatchlists({ date });
      return formatToolResult(result);
    },
  });
}
