# Gateway BRAIN

This folder contains the live transport runtime for Dexter messaging channels.

For the `dexter-telegram` project, this folder is the operational heart of the bot.

## Entry Point

Main entry:

- `src/gateway/index.ts`

Runtime start command:

```bash
bun run gateway
```

That command resolves config, starts the channel manager, boots enabled plugins, and keeps the bot running until `SIGINT` or `SIGTERM`.

## What Starts

`src/gateway/index.ts`:

- handles CLI mode selection
- supports `run` and `login`
- starts the gateway via `startGateway()`
- shuts down cleanly on `Ctrl+C`

`src/gateway/gateway.ts`:

- creates channel plugins
- receives inbound messages
- resolves routing/session keys
- runs the agent
- sends replies back to Telegram or WhatsApp
- enforces Telegram safety and trade-confirmation flow

## Key Subsystems

- `channels/`
  Telegram and WhatsApp transport adapters
- `routing/`
  Maps inbound chats to the right agent/session identity
- `sessions/`
  Persists session metadata
- `heartbeat/`
  Heartbeat scheduling/prompt support used by trade policy
- `group/`
  Group-history buffering, mention detection, and member tracking
- `config.ts`
  Loads and validates gateway config

## Telegram-Specific Flow

Telegram runtime files of interest:

- `channels/telegram/plugin.ts`
- `channels/telegram/index.ts`
- `channels/telegram/trade-confirmations.ts`
- `channels/telegram/safety-policy.ts`

Telegram-specific behavior:

- polls Telegram using `TELEGRAM_BOT_TOKEN`
- cleans markdown for Telegram-safe delivery
- supports confirmation-gated trade requests
- records token usage and confirmed trade counts
- blocks writes when heartbeat/policy/health checks fail

## Config Sources

Primary config file:

- `.dexter/gateway.json`

Optional overrides:

- `DEXTER_GATEWAY_CONFIG`
- `DEXTER_TELEGRAM_SAFETY_STATE_PATH`
- `DEXTER_SESSIONS_DIR`

Token source:

- `.env` / `TELEGRAM_BOT_TOKEN`

## Start/Stop Reality

This gateway is a foreground process by default.

Normal operator pattern:

```bash
cd /Users/keespronk/Python_Dev/dexter-telegram
bun run gateway
```

Stop:

```text
Ctrl+C
```

There is no built-in service/unit definition in this repo right now.

## Failure Modes To Expect

- `409 Conflict` from Telegram means another poller is using the same token
- stale or unavailable AlgoTrader health blocks trade-request writes
- malformed or missing `.dexter/gateway.json` falls back to defaults, which may disable trade requests

## Most Important Files

- `index.ts`
- `gateway.ts`
- `config.ts`
- `agent-runner.ts`
- `channels/telegram/*`
- `routing/resolve-route.ts`
- `sessions/store.ts`
