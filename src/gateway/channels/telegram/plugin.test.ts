import { describe, expect, test } from 'bun:test';
import { createTelegramPlugin } from './plugin.js';

describe('telegram plugin', () => {
  test('requires both a bot token and an explicit allowlist', async () => {
    const plugin = createTelegramPlugin({
      loadConfig: () =>
        ({
          gateway: { accountId: 'default', logLevel: 'info' },
          channels: {
            whatsapp: { enabled: true, accounts: {}, allowFrom: [] },
            telegram: { enabled: true, accounts: {}, allowFrom: [] },
          },
          bindings: [],
        }) as never,
      onMessage: async () => {},
    });

    expect(await plugin.config.isConfigured?.({ accountId: 'default', enabled: true, botToken: '', allowFrom: [] } as never, {} as never)).toBe(false);
    expect(await plugin.config.isConfigured?.({ accountId: 'default', enabled: true, botToken: 'token', allowFrom: [] } as never, {} as never)).toBe(false);
    expect(await plugin.config.isConfigured?.({ accountId: 'default', enabled: true, botToken: 'token', allowFrom: ['12345'] } as never, {} as never)).toBe(true);
  });
});
