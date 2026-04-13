import TelegramBot from 'node-telegram-bot-api';
import { chunkTelegramHtml, stripTelegramHtml } from '../../utils.js';

export type TelegramInboundMessage = {
  channel: 'telegram';
  id?: string;
  accountId: string;
  chatId: string;
  replyToJid: string; // Map chatId to replyToJid for compatibility
  chatType: 'direct' | 'group';
  from: string; // Map senderId to from for compatibility
  senderId: string;
  senderName?: string;
  isFromMe?: boolean;
  selfE164?: string | null;
  groupSubject?: string; // name of the group for group context
  groupParticipants?: string[]; 
  mentionedJids?: string[];
  selfJid?: string | null;
  selfLid?: string | null;
  body: string;
  timestamp?: number;
  sendComposing: () => Promise<void>;
  reply: (text: string) => Promise<void>;
  replyWithTradeConfirmation: (text: string, token: string) => Promise<void>;
};

export async function monitorTelegramChannel(params: {
  accountId: string;
  botToken: string;
  allowFrom: string[];
  abortSignal: AbortSignal;
  onMessage: (msg: TelegramInboundMessage) => Promise<void>;
  onStatus: (status: { connected: boolean; lastError?: string }) => void;
}) {
  const { accountId, botToken, allowFrom, abortSignal, onMessage, onStatus } = params;

  try {
    const bot = new TelegramBot(botToken, { polling: true });
    const me = await bot.getMe();
    const selfId = String(me.id);
    const selfMention = me.username ? `@${me.username.toLowerCase()}` : null;

    const stopBot = async () => {
      bot.removeAllListeners('message');
      bot.removeAllListeners('polling_error');
      await bot.stopPolling().catch(() => {});
      onStatus({ connected: false });
    };

    abortSignal.addEventListener(
      'abort',
      () => {
        void stopBot();
      },
      { once: true },
    );

    onStatus({ connected: true });

    bot.on('message', async (msg) => {
      if (abortSignal.aborted || !msg.text) return;

      const chatId = String(msg.chat.id);
      const senderId = String(msg.from?.id ?? '');
      const senderName = msg.from?.username ?? msg.from?.first_name ?? 'unknown';
      const isGroup = msg.chat.type !== 'private';
      const chatType = isGroup ? 'group' : 'direct';

      const allowed = allowFrom.includes('*') || allowFrom.includes(chatId);
      if (!allowed) {
        console.log(`[telegram] Blocked message from chat ${chatId} sender ${senderName} (${senderId})`);
        return;
      }

      let mentionedJids: string[] = [];
      if (selfMention && msg.text.toLowerCase().includes(selfMention)) {
        mentionedJids.push(selfId);
      }

      let groupSubject = isGroup ? msg.chat.title : undefined;

      const inbound: TelegramInboundMessage = {
        channel: 'telegram',
        accountId,
        chatId,
        replyToJid: chatId, 
        from: String(msg.chat.id),
        senderId,
        senderName,
        body: msg.text,
        chatType,
        groupSubject,
        selfJid: selfId,
        selfE164: selfId,
        mentionedJids,
        reply: async (text: string) => {
          for (const chunk of chunkTelegramHtml(text, 4000)) {
            await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML' }).catch((err) => {
              console.error('[telegram] HTML parse failure, retrying as plain text...', err.message);
              return bot.sendMessage(chatId, stripTelegramHtml(chunk));
            });
          }
        },
        replyWithTradeConfirmation: async (text: string, token: string) => {
          await bot.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: 'Confirm trade', callback_data: `trade_confirm:${token}` },
                { text: 'Cancel', callback_data: `trade_cancel:${token}` },
              ]],
            },
          });
        },
        sendComposing: async () => {
          await bot.sendChatAction(chatId, 'typing').catch(() => {});
        }
      };

      await onMessage(inbound);
    });

    bot.on('callback_query', async (query) => {
      const data = query.data ?? '';
      const message = query.message;
      if (!message?.chat?.id || !query.from?.id) {
        return;
      }
      if (!data.startsWith('trade_confirm:') && !data.startsWith('trade_cancel:')) {
        return;
      }

      const chatId = String(message.chat.id);
      const senderId = String(query.from.id);
      const senderName = query.from.username ?? query.from.first_name ?? 'unknown';
      const token = data.split(':', 2)[1] ?? '';
      const isConfirm = data.startsWith('trade_confirm:');

      await bot.answerCallbackQuery(query.id).catch(() => {});
      if (query.message?.message_id) {
        await bot
          .editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: message.chat.id, message_id: query.message.message_id },
          )
          .catch(() => {});
      }

      const inbound: TelegramInboundMessage = {
        channel: 'telegram',
        accountId,
        chatId,
        replyToJid: chatId,
        from: chatId,
        senderId,
        senderName,
        body: `${isConfirm ? '__telegram_trade_confirm__:' : '__telegram_trade_cancel__:'}${token}`,
        chatType: message.chat.type !== 'private' ? 'group' : 'direct',
        groupSubject: message.chat.type !== 'private' ? message.chat.title : undefined,
        selfJid: selfId,
        selfE164: selfId,
        mentionedJids: [],
        reply: async (text: string) => {
          for (const chunk of chunkTelegramHtml(text, 4000)) {
            await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML' }).catch((err) => {
              console.error('[telegram] HTML parse failure, retrying as plain text...', err.message);
              return bot.sendMessage(chatId, stripTelegramHtml(chunk));
            });
          }
        },
        replyWithTradeConfirmation: async (text: string, confirmToken: string) => {
          await bot.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: 'Confirm trade', callback_data: `trade_confirm:${confirmToken}` },
                { text: 'Cancel', callback_data: `trade_cancel:${confirmToken}` },
              ]],
            },
          });
        },
        sendComposing: async () => {
          await bot.sendChatAction(chatId, 'typing').catch(() => {});
        },
      };

      await onMessage(inbound);
    });

    bot.on('polling_error', (error) => {
      const lastError = error.message.includes('409 Conflict')
        ? 'Telegram 409 Conflict: another getUpdates poller is already using this bot token. Use a dedicated Dexter Telegram token.'
        : error.message;
      onStatus({ connected: false, lastError });
      console.error(`[telegram] Polling error: ${lastError}`);
    });

    await new Promise<void>((resolve) => {
      abortSignal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    });

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    onStatus({ connected: false, lastError: errorMsg });
  }
}
