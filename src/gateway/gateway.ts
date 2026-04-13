import { createChannelManager } from './channels/manager.js';
import {
  cancelPendingTelegramTrade,
  confirmPendingTelegramTrade,
  extractTelegramTradeMarker,
} from './channels/telegram/trade-confirmations.js';
import {
  assertTelegramDailyBudget,
  recordTelegramHandledChatAndMaybeGetCostEstimate,
  recordTelegramTokenUsage,
} from './channels/telegram/safety-policy.js';
import { createWhatsAppPlugin } from './channels/whatsapp/plugin.js';
import { createTelegramPlugin } from './channels/telegram/plugin.js';
import {
  assertOutboundAllowed,
  sendComposing,
  sendMessageWhatsApp,
  type WhatsAppInboundMessage,
} from './channels/whatsapp/index.js';
import type { TelegramInboundMessage } from './channels/telegram/index.js';

export type InboundMessage = (WhatsAppInboundMessage & { channel?: 'whatsapp' }) | TelegramInboundMessage;
import { resolveRoute } from './routing/resolve-route.js';
import { resolveSessionStorePath, upsertSessionMeta } from './sessions/store.js';
import { loadGatewayConfig, type GatewayConfig } from './config.js';
import { runAgentForMessage, isSessionRunning, enqueueForSession } from './agent-runner.js';
import { cleanMarkdownForWhatsApp, cleanMarkdownForTelegram } from './utils.js';
import { startCronRunner } from '../cron/runner.js';
import { ensureHeartbeatCronJob } from '../cron/heartbeat-migration.js';
import {
  isBotMentioned,
  recordGroupMessage,
  getAndClearGroupHistory,
  formatGroupHistoryContext,
  noteGroupMember,
  formatGroupMembersList,
} from './group/index.js';
import type { GroupContext } from '../agent/prompts.js';
import { appendFileSync } from 'node:fs';
import { dexterPath } from '../utils/paths.js';
import { getSetting } from '../utils/config.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../model/llm.js';

const LOG_PATH = dexterPath('gateway-debug.log');
function debugLog(msg: string) {
  appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
}

export type GatewayService = {
  stop: () => Promise<void>;
  snapshot: () => Record<string, { accountId: string; running: boolean; connected?: boolean }>;
};

function elide(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

async function handleInbound(cfg: GatewayConfig, inbound: InboundMessage): Promise<void> {
  if (inbound.channel === 'telegram' && inbound.body.startsWith('__telegram_trade_confirm__:')) {
    const token = inbound.body.split(':', 2)[1] ?? '';
    const result = await confirmPendingTelegramTrade({
      token,
      chatId: inbound.chatId,
      userId: inbound.senderId,
      config: cfg,
    });
    await inbound.reply(cleanMarkdownForTelegram(result.message));
    return;
  }

  if (inbound.channel === 'telegram' && inbound.body.startsWith('__telegram_trade_cancel__:')) {
    const token = inbound.body.split(':', 2)[1] ?? '';
    const result = cancelPendingTelegramTrade({
      token,
      chatId: inbound.chatId,
      userId: inbound.senderId,
    });
    await inbound.reply(cleanMarkdownForTelegram(result.message));
    return;
  }

  const bodyPreview = elide(inbound.body.replace(/\n/g, ' '), 50);
  const isGroup = inbound.chatType === 'group';
  console.log(`Inbound message ${inbound.from} (${inbound.chatType}, ${inbound.body.length} chars): "${bodyPreview}"`);
  debugLog(`[gateway] handleInbound from=${inbound.from} isGroup=${isGroup} body="${inbound.body.slice(0, 30)}..."`);

  // --- Group-specific: track member, check mention gating ---
  if (isGroup) {
    noteGroupMember(inbound.chatId, inbound.senderId, inbound.senderName);

    const mentioned = isBotMentioned({
      mentionedJids: inbound.mentionedJids,
      selfJid: inbound.selfJid,
      selfLid: inbound.selfLid,
      selfE164: inbound.selfE164,
      body: inbound.body,
    });
    debugLog(`[gateway] group mention check: mentioned=${mentioned}`);

    if (!mentioned) {
      // Buffer the message for future context but don't reply
      recordGroupMessage(inbound.chatId, {
        senderName: inbound.senderName ?? inbound.senderId,
        senderId: inbound.senderId,
        body: inbound.body,
        timestamp: inbound.timestamp ?? Date.now(),
      });
      debugLog(`[gateway] group message buffered (no mention), skipping reply`);
      return;
    }
  }

  // --- Routing: use chatId for groups (group JID), senderId for DMs ---
  const peerId = isGroup ? inbound.chatId : inbound.senderId;
  const channelId = inbound.channel ?? 'whatsapp';
  const route = resolveRoute({
    cfg,
    channel: channelId,
    accountId: inbound.accountId,
    peer: { kind: inbound.chatType, id: peerId },
  });

  const storePath = resolveSessionStorePath(route.agentId);
  upsertSessionMeta({
    storePath,
    sessionKey: route.sessionKey,
    channel: channelId,
    to: inbound.from,
    accountId: route.accountId,
    agentId: route.agentId,
  });

  // Start typing indicator loop to keep it alive during long agent runs
  const TYPING_INTERVAL_MS = 5000; // Refresh every 5 seconds
  let typingTimer: ReturnType<typeof setInterval> | undefined;

  const startTypingLoop = async () => {
    // For groups, use inbound.sendComposing directly (bypasses outbound strict checks)
    if (isGroup) {
      await inbound.sendComposing();
      typingTimer = setInterval(() => { void inbound.sendComposing(); }, TYPING_INTERVAL_MS);
    } else {
      if (channelId === 'telegram') {
        await inbound.sendComposing();
        typingTimer = setInterval(() => { void inbound.sendComposing(); }, TYPING_INTERVAL_MS);
      } else {
        await sendComposing({ to: inbound.replyToJid, accountId: inbound.accountId });
        typingTimer = setInterval(() => {
          void sendComposing({ to: inbound.replyToJid, accountId: inbound.accountId });
        }, TYPING_INTERVAL_MS);
      }
    }
  };

  const stopTypingLoop = () => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
  };

  try {
    if (channelId === 'telegram') {
      try {
        assertTelegramDailyBudget({ config: cfg });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await inbound.reply(cleanMarkdownForTelegram(`I can’t process more Telegram requests today.\n\nReason: ${msg}`));
        return;
      }
    }

    // Defense-in-depth: verify outbound destination is allowed before any messaging
    // For groups, use chatId (the group JID); for DMs, use replyToJid
    const outboundTarget = isGroup ? inbound.chatId : inbound.replyToJid;
    if (channelId === 'whatsapp') {
      try {
        assertOutboundAllowed({ to: outboundTarget, accountId: inbound.accountId });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        debugLog(`[gateway] outbound BLOCKED: ${msg}`);
        console.log(msg);
        return;
      }
    }

    await startTypingLoop();

    // --- Build query: for groups, include buffered history context ---
    let query = inbound.body;
    let groupContext: GroupContext | undefined;

    if (isGroup) {
      const history = getAndClearGroupHistory(inbound.chatId);
      query = formatGroupHistoryContext({
        history,
        currentSenderName: inbound.senderName ?? inbound.senderId,
        currentSenderId: inbound.senderId,
        currentBody: inbound.body,
      });
      debugLog(`[gateway] group query with ${history.length} history entries`);

      const membersList = formatGroupMembersList({
        groupId: inbound.chatId,
        participants: inbound.groupParticipants,
      });
      groupContext = {
        groupName: inbound.groupSubject,
        membersList: membersList || undefined,
        activationMode: 'mention',
      };
    }

    console.log(`Processing message with agent...`);
    const model = getSetting('modelId', DEFAULT_MODEL) as string;
    const modelProvider = getSetting('provider', DEFAULT_PROVIDER) as string;

    // If agent is already running for this session, enqueue for mid-run injection
    if (isSessionRunning(route.sessionKey)) {
      debugLog(`[gateway] agent busy for session=${route.sessionKey}, enqueueing`);
      enqueueForSession(route.sessionKey, model, query);
      return;
    }

    debugLog(`[gateway] running agent for session=${route.sessionKey}`);
    const startedAt = Date.now();
    const answer = await runAgentForMessage({
      sessionKey: route.sessionKey,
      query,
      model,
      modelProvider,
      channel: channelId,
      groupContext,
      channelContext: channelId === 'telegram'
        ? {
            telegramChatId: inbound.chatId,
            telegramUserId: inbound.senderId,
          }
        : undefined,
      onEvent: async (event) => {
        if (event.type === 'done' && channelId === 'telegram') {
          recordTelegramTokenUsage({ tokenUsage: event.tokenUsage, config: cfg });
        }
      },
    });
    const durationMs = Date.now() - startedAt;
    debugLog(`[gateway] agent answer length=${answer.length}`);

    // Stop typing loop before sending reply
    stopTypingLoop();

    if (answer.trim()) {
      let cleanedAnswer = channelId === 'telegram'
        ? cleanMarkdownForTelegram(answer).trim()
        : cleanMarkdownForWhatsApp(answer).trim();

      if (channelId === 'telegram') {
        const costEstimate = recordTelegramHandledChatAndMaybeGetCostEstimate({
          modelId: model,
          config: cfg,
        });
        // [FIX-179] Every tenth Telegram chat gets a running cost estimate note.
        if (costEstimate) {
          cleanedAnswer = `${cleanedAnswer}\n\n${cleanMarkdownForTelegram(costEstimate)}`.trim();
        }
      }

      if (channelId === 'telegram') {
        const confirmation = extractTelegramTradeMarker(cleanedAnswer);
        debugLog(`[gateway] sending target independent reply via telegram wrapper`);
        if (confirmation) {
          await inbound.replyWithTradeConfirmation(confirmation.text, confirmation.token);
        } else {
          await inbound.reply(cleanedAnswer);
        }
      } else if (isGroup) {
        // For groups, use inbound.reply() directly (bypasses outbound strict E.164 checks)
        debugLog(`[gateway] sending group reply to ${inbound.chatId}`);
        await inbound.reply(cleanedAnswer);
      } else {
        debugLog(`[gateway] sending reply to ${inbound.replyToJid}`);
        await sendMessageWhatsApp({
          to: inbound.replyToJid,
          body: cleanedAnswer,
          accountId: inbound.accountId,
        });
      }
      console.log(`Sent reply (${answer.length} chars, ${durationMs}ms)`);
      debugLog(`[gateway] reply sent`);
    } else {
      console.log(`Agent returned empty response (${durationMs}ms)`);
      debugLog(`[gateway] empty answer, not sending`);
    }
  } catch (err) {
    stopTypingLoop();
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${msg}`);
    debugLog(`[gateway] ERROR: ${msg}`);
  }
}

export async function startGateway(params: { configPath?: string } = {}): Promise<GatewayService> {
  const cfg = loadGatewayConfig(params.configPath);
  const whatsappPlugin = createWhatsAppPlugin({
    loadConfig: () => loadGatewayConfig(params.configPath),
    onMessage: async (inbound) => {
      const current = loadGatewayConfig(params.configPath);
      await handleInbound(current, { ...inbound, channel: 'whatsapp' });
    },
  });
  const telegramPlugin = createTelegramPlugin({
    loadConfig: () => loadGatewayConfig(params.configPath),
    onMessage: async (inbound) => {
      const current = loadGatewayConfig(params.configPath);
      await handleInbound(current, inbound);
    },
  });
  
  const whatsappManager = createChannelManager({
    plugin: whatsappPlugin,
    loadConfig: () => loadGatewayConfig(params.configPath),
  });
  
  const telegramManager = createChannelManager({
    plugin: telegramPlugin,
    loadConfig: () => loadGatewayConfig(params.configPath),
  });

  await whatsappManager.startAll();
  await telegramManager.startAll();

  ensureHeartbeatCronJob(params.configPath);
  const cron = startCronRunner({ configPath: params.configPath });

  return {
    stop: async () => {
      cron.stop();
      await whatsappManager.stopAll();
      await telegramManager.stopAll();
    },
    snapshot: () => ({ ...whatsappManager.getSnapshot(), ...telegramManager.getSnapshot() }),
  };
}
