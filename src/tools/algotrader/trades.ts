import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { AlgoTraderGatewayClient } from './client.js';

export const ALGOTRADER_TRADES_DESCRIPTION = `
Read recent AlgoTrader trade history from the Python monitor server.

By default the Python endpoint excludes simulated trades. Use includeSim only when the user explicitly asks for simulated or debug rows.
`.trim();

export function createAlgoTraderTradesTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'algotrader_trades',
    description: 'Read recent AlgoTrader trade history, excluding simulated rows by default.',
    schema: z.object({
      includeSim: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include simulated trades. Only use when the user explicitly asks for them.'),
    }),
    func: async (input) => {
      const client = new AlgoTraderGatewayClient();
      const result = await client.getTrades({ includeSim: input.includeSim });
      return formatToolResult(result);
    },
  });
}
