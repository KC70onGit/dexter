import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { AlgoTraderGatewayClient } from './client.js';

export const ALGOTRADER_POSITIONS_DESCRIPTION = `
Read the live AlgoTrader positions snapshot through the local monitor server.

Use this when the user asks what is currently open, what size is on, or whether the book is stale.
Always treat this as the source of truth for live positions, not conversational memory.
`.trim();

export function createAlgoTraderPositionsTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'algotrader_positions',
    description: 'Read the live AlgoTrader positions snapshot, including freshness metadata.',
    schema: z.object({}),
    func: async () => {
      const client = new AlgoTraderGatewayClient();
      const result = await client.getPositions();
      return formatToolResult(result);
    },
  });
}
