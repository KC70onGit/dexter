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

Use this for explicit AlgoTrader regime requests: "/MR", "AlgoTrader regime",
"SPY regime", "QQQ/VIX regime snapshot", or "what does the bot say the regime is?"

Do not use this for broad market, macro, geopolitical, or news questions such as
"how is the market doing?" Those should be answered by Dexter using market data,
news/search, and reasoning without requiring the AlgoTrader monitor to be online.

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
