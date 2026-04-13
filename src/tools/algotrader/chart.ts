import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { AlgoTraderGatewayClient } from './client.js';

export const ALGOTRADER_CHART_DESCRIPTION = `
Read a cached AlgoTrader chart payload for a specific ticker.

Use this when the user asks for a chart view or ticker-specific visual context that the Python monitor server already has cached.
`.trim();

export function createAlgoTraderChartTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'algotrader_chart',
    description: 'Read a cached AlgoTrader chart payload for a specific ticker.',
    schema: z.object({
      ticker: z.string().min(1).describe('Ticker symbol to load from the AlgoTrader chart cache.'),
    }),
    func: async (input) => {
      const client = new AlgoTraderGatewayClient();
      const result = await client.getChart(input.ticker);
      return formatToolResult(result);
    },
  });
}
