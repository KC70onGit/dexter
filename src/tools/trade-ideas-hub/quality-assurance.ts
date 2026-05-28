import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { TradeIdeasHubClient } from './client.js';

export const TRADE_IDEAS_QUALITY_ASSURANCE_DESCRIPTION = `
Read Trade Ideas Hub quality-assurance truth.

Use this when the user asks about pipeline QA, candidate validation, artifact freshness,
data quality, or why the integrated/opening universe is or is not usable.
Reads the Hub API first and falls back to runtime QA plus preopen validation artifacts.

This summarizes existing QA evidence only; it is not a second QA model or a new pass/fail authority.
`.trim();

export function createTradeIdeasQualityAssuranceTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'trade_ideas_quality_assurance',
    description: TRADE_IDEAS_QUALITY_ASSURANCE_DESCRIPTION,
    schema: z.object({
      date: z.string().optional().describe('Optional YYYY-MM-DD artifact date for local fallback.'),
    }),
    func: async ({ date }) => {
      const client = new TradeIdeasHubClient();
      const result = await client.getQualityAssurance({ date });
      return formatToolResult(result);
    },
  });
}
