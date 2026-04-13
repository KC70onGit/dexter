import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { AlgoTraderGatewayClient } from './client.js';

export const ALGOTRADER_SIGNALS_DESCRIPTION = `
Read the current active AlgoTrader signals from the live monitor server.

Use this when the user asks which names are active, what the scanner currently likes, or whether a ticker is in the live signal set.
`.trim();

export function createAlgoTraderSignalsTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'algotrader_signals',
    description: 'Read the current live AlgoTrader signal list with freshness metadata.',
    schema: z.object({}),
    func: async () => {
      const client = new AlgoTraderGatewayClient();
      const result = await client.getSignals();
      return formatToolResult(result);
    },
  });
}
