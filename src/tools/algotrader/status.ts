// [FIX-185] Dedicated IBKR/runtime status tool — reads /api/status for broker connectivity.
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { AlgoTraderGatewayClient } from './client.js';

export const ALGOTRADER_STATUS_DESCRIPTION = `
Read the AlgoTrader runtime status for IBKR broker connectivity.

Use this tool when the user asks about IBKR, TWS, Gateway, broker connectivity,
or "can I trade right now?" questions. This reads /api/status which probes the
actual IBKR gateway ports and engine connection state.

Do NOT use this for monitor freshness or session-state questions — use
algotrader_health for those instead.

Key fields in the response:
- gateway_reachable: whether an IBKR gateway/TWS port responded to a TCP probe
- gateway_port: which port answered (4001/4002 = Gateway, 7496/7497 = TWS)
- engine_ib_connected: whether the trading engine has an active IBKR API connection
- broker_state: derived summary — "connected", "gateway_only", "unreachable", or "unknown"
- operator_guidance: human-readable explanation of the current state

Routing rules:
- "Is IBKR up?" → use this tool
- "Is the engine connected?" → use this tool
- "Is the monitor fresh?" → use algotrader_health
- "Can I trade?" / "Is the stack healthy?" → use BOTH this tool AND algotrader_health
`.trim();

export function createAlgoTraderStatusTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'algotrader_status',
    description: 'Read IBKR broker/gateway connectivity and runtime stack state.',
    schema: z.object({}),
    func: async () => {
      const client = new AlgoTraderGatewayClient();
      const result = await client.getStatus();
      return formatToolResult(result);
    },
  });
}
