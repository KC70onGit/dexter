import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { AlgoTraderGatewayClient } from './client.js';

export const ALGOTRADER_HEALTH_DESCRIPTION = `
Read the current AlgoTrader health snapshot.

Use this before making claims about live state or before any write flow.
If the result is stale or session_state is NO_DATA, treat live trading context as degraded.
`.trim();

export function createAlgoTraderHealthTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'algotrader_health',
    description: 'Read AlgoTrader runtime health and freshness for the live stack.',
    schema: z.object({}),
    func: async () => {
      const client = new AlgoTraderGatewayClient();
      const result = await client.getHealth();
      return formatToolResult(result);
    },
  });
}
