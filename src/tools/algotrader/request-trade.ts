import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { loadGatewayConfig } from '../../gateway/config.js';
import { preparePendingTelegramTrade } from '../../gateway/channels/telegram/trade-confirmations.js';

export const ALGOTRADER_REQUEST_TRADE_DESCRIPTION = `
Prepare a live AlgoTrader trade request for Telegram confirmation.

This tool does not execute a trade immediately. It creates a pending request and returns a confirmation marker that the Telegram gateway converts into deterministic Confirm/Cancel buttons.

Use this only when the user is explicitly asking to place a trade. When this tool succeeds, you must include the returned marker line exactly once and unchanged in your final answer so the Telegram gateway can render the confirmation buttons.
`.trim();

const schema = z.object({
  chatId: z.string().min(1).describe('Telegram chat id for the requesting user.'),
  userId: z.string().min(1).describe('Telegram user id for the requesting user.'),
  ticker: z.string().min(1).describe('Ticker to trade.'),
  side: z.enum(['BUY', 'SELL']).describe('BUY for long entry, SELL for short entry.'),
  amountUsd: z.number().positive().describe('Dollar amount to submit.'),
  tradeIntent: z.enum(['OPEN', 'ADD']).optional().default('OPEN'),
});

export function createAlgoTraderRequestTradeTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'algotrader_request_trade',
    description: 'Prepare a pending live trade request for Telegram confirmation buttons. Does not execute immediately.',
    schema,
    func: async (input) => {
      try {
        const pending = await preparePendingTelegramTrade({
          chatId: input.chatId,
          userId: input.userId,
          ticker: input.ticker,
          side: input.side,
          amountUsd: input.amountUsd,
          tradeIntent: input.tradeIntent,
          config: loadGatewayConfig(),
        });
        return [
          `Prepared trade request: ${pending.summary}.`,
          'If you want the user to confirm it in Telegram, include the marker line below exactly once and unchanged in your final answer:',
          `[[DEXTER_TRADE_CONFIRMATION token=${pending.token}]]`,
        ].join('\n');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Trade request could not be prepared: ${message}`;
      }
    },
  });
}
