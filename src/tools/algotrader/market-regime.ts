/**
 * algotrader_market_regime tool — read current SPY market regime from AlgoTrader.
 *
 * [FIX-403] Follows the established AlgoTraderGatewayClient read-path architecture.
 * Uses the typed client (no web_fetch cache issues — always fresh).
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { AlgoTraderGatewayClient } from './client.js';

export const ALGOTRADER_MARKET_REGIME_DESCRIPTION = `
Read the current market regime snapshot from AlgoTrader.

Returns the live SPY classification (BULLISH / BEARISH / CHOPPY),
QQQ growth-risk bias, VIX stress state, derived market style, and SPY/QQQ oscillator detail.

Use this when the user asks about market regime, market conditions, "should I trade",
"/MR", "what's the regime", "is the market bullish/bearish", or general market health.
This is the primary tool for broad market environment questions.

Do NOT use algotrader_health for regime questions — that tool is for monitor/session freshness only.
`.trim();

export function createAlgoTraderMarketRegimeTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'algotrader_market_regime',
    description: 'Read the current SPY market regime, QQQ bias, VIX stress, and market style.',
    schema: z.object({}),
    func: async () => {
      const client = new AlgoTraderGatewayClient();
      const result = await client.getMarketRegime();
      return formatToolResult(result);
    },
  });
}
