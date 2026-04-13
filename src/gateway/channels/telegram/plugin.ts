import type { GatewayConfig, TelegramAccountConfig } from '../../config.js';
import { listTelegramAccountIds, resolveTelegramAccount } from '../../config.js';
import type { ChannelPlugin } from '../types.js';
import { monitorTelegramChannel, type TelegramInboundMessage } from './runtime.js';

export function createTelegramPlugin(params: {
  loadConfig: () => GatewayConfig;
  onMessage: (msg: TelegramInboundMessage) => Promise<void>;
}): ChannelPlugin<GatewayConfig, TelegramAccountConfig> {
  return {
    id: 'telegram',
    config: {
      listAccountIds: (cfg) => listTelegramAccountIds(cfg),
      resolveAccount: (cfg, accountId) => resolveTelegramAccount(cfg, accountId),
      isEnabled: (account, cfg) => account.enabled && cfg.channels.telegram.enabled !== false,
      isConfigured: (account) => Boolean(account.botToken) && account.allowFrom.length > 0,
    },
    gateway: {
      startAccount: async (ctx) => {
        await monitorTelegramChannel({
          accountId: ctx.accountId,
          botToken: ctx.account.botToken,
          allowFrom: ctx.account.allowFrom,
          abortSignal: ctx.abortSignal,
          onMessage: params.onMessage,
          onStatus: (status) => {
            ctx.setStatus({
              connected: status.connected,
              lastError: status.lastError ?? null,
            });
          },
        });
      },
    },
    status: {
      defaultRuntime: {
        accountId: 'default',
        running: false,
        connected: false,
        lastError: null,
      },
    },
  };
}
