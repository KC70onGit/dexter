import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { TradeIdeasHubClient } from './client.js';

export const TRADE_IDEAS_OPENING_SESSION_DESCRIPTION = `
Read Trade Ideas Hub opening-session evidence.

Use this when the user asks about opening-session candidates, preopen readiness,
opening plan state, router/validation evidence, or whether today's opening setup looks usable.
Reads the Hub API first and falls back to persisted opening artifacts.

This is read-only evidence joining. It does not route orders or override AlgoTrader gates.
`.trim();

export function createTradeIdeasOpeningSessionTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'trade_ideas_opening_session',
    description: TRADE_IDEAS_OPENING_SESSION_DESCRIPTION,
    schema: z.object({
      date: z.string().optional().describe('Optional YYYY-MM-DD artifact date for local fallback.'),
    }),
    func: async ({ date }) => {
      const client = new TradeIdeasHubClient();
      const result = await client.getOpeningSession({ date });
      return formatToolResult(result);
    },
  });
}
