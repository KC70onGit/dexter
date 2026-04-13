# Dexter-Telegram BRAIN

This repo is the dedicated `dexter-telegram` checkout for the Telegram trading-buddy bridge.
It is separate from the main AlgoTrader repo and should be treated as its own app/runtime.

Current working split:

- dev checkout: `/Users/keespronk/Python_Dev/dexter-telegram`
- prod checkout: `/Users/keespronk/Python/dexter-telegram`

## What This Repo Runs

There are two practical run modes:

1. `bun run start`
   Starts the standard Dexter interactive app.
   This is not the Telegram bot process.

2. `bun run gateway`
   Starts the Telegram/WhatsApp gateway runtime.
   This is the command that runs the `dexter-telegram` bot.

For development:

```bash
cd /Users/keespronk/Python_Dev/dexter-telegram
bun run dev
```

That auto-restarts on file changes, but it is still a foreground process.

## Start And Stop Model

The repo now carries a prod launchd wrapper, but dev remains manual.

Current operating model:

- prod checkout runs as a `launchd` service
- dev checkout runs manually in a terminal
- stop dev with `Ctrl+C`
- never run dev and prod at the same time on the shared Telegram token

Recommended split with one Telegram token:

- prod checkout runs as the only normal live bot
- dev checkout stays manual/terminal-only
- never run dev and prod at the same time on one shared token

Recommended mental model:

- `bun run start` = local interactive Dexter
- `bun run gateway` = live messaging bot
- `./scripts/prod_service.sh ...` = prod launchd lifecycle wrapper

Current prod service label:

- `com.keespronk.dexter-telegram.prod`

## Required Runtime Inputs

Required local pieces:

- `.env`
- `.dexter/gateway.json`
- `.dexter/telegram-safety.json`

Important env/config expectations:

- `TELEGRAM_BOT_TOKEN` is read from `.env`
- `ALGOTRADER_BASE_URL` defaults to `http://127.0.0.1:8787`
- `DEXTER_GATEWAY_CONFIG` is optional and defaults to `.dexter/gateway.json`
- `DEXTER_TELEGRAM_SAFETY_STATE_PATH` is optional and defaults to `.dexter/telegram-safety.json`
- `DEXTER_RUNTIME_NAME` and `DEXTER_RUNTIME_ROLE` are optional explicit identity labels shown in the agent prompt when users ask whether they are talking to dev or prod
- if `.dexter/settings.json` does not exist yet, Dexter now auto-picks the first provider with a configured API key instead of assuming OpenAI
- `.dexter/settings.json` is the persisted runtime model/provider selection used by the gateway

Suggested explicit values:

- dev checkout:
  - `DEXTER_RUNTIME_NAME=dev`
  - `DEXTER_RUNTIME_ROLE=development`
- prod checkout:
  - `DEXTER_RUNTIME_NAME=prod`
  - `DEXTER_RUNTIME_ROLE=production`

Current aligned selection in both dev and prod:

- provider: `google`
- model: `gemini-3-flash-preview`

## External Dependency

The bridge expects AlgoTrader's monitor server to be reachable.

Default endpoint:

```text
http://127.0.0.1:8787
```

Important endpoints used by the bridge:

- `GET /api/health`
- `GET /api/positions`
- `GET /api/signals`
- `GET /api/trades`
- `GET /api/chart?ticker=...`
- `POST /api/trade`

If the health endpoint is stale, `NO_DATA`, or fresh `MARKET_CLOSED`, trade-request writes are blocked by policy.

Health interpretation nuance:

- stale `MARKET_CLOSED` is not treated as proof the exchange is currently closed
- `NO_DATA` means the monitor has no live session data
- the health tool now emits `session_state_authoritative` and `market_hours_inference_allowed` so Dexter can say "monitor is stale/offline" instead of overstating exchange status

## Repo Map

Top-level folders that matter operationally:

- `src/gateway/`
  Transport/runtime layer for Telegram and WhatsApp
- `src/tools/algotrader/`
  Typed client/tools for talking to the Python AlgoTrader monitor server
- `.dexter/`
  Local runtime state, gateway config, logs, sessions, memory, and safety counters
- `src/agent/`
  Agent prompt/runtime logic
- `src/tools/`
  General tool registry and implementations

## Telegram Trading Buddy Bridge

Current bridge behavior:

- Telegram transport lives in `src/gateway/channels/telegram/`
- long replies are cleaned and chunked for Telegram delivery
- trade requests are staged through Telegram confirmation markers
- confirmed requests are audited to `.dexter/telegram-trade-audit.jsonl`
- trade writes are policy-gated by heartbeat and daily limits
- live-state answers should explicitly distinguish fresh monitor truth from stale/offline monitor snapshots

## Operational Notes

- If Telegram returns `409 Conflict`, another poller is already using the same bot token.
- In this setup, the normal fix is to stop the other process. Prod is the default live runtime; dev should only be started manually after prod is stopped.
- `bun run typecheck` currently exposes upstream code/test typing issues; that is separate from the gateway's runtime bootability.

## Prod Service

The repo now carries a launchd plist template for prod:

- `ops/launchd/com.keespronk.dexter-telegram.prod.plist`

And a helper wrapper:

- `scripts/prod_service.sh`

Useful commands:

```bash
cd /Users/keespronk/Python_Dev/dexter-telegram
./scripts/prod_service.sh install
./scripts/prod_service.sh status
./scripts/prod_service.sh stop
./scripts/prod_service.sh start
./scripts/prod_service.sh logs
```

`install` copies the plist into:

- `~/Library/LaunchAgents/com.keespronk.dexter-telegram.prod.plist`

and then bootstraps it from there.

This service points at the prod checkout:

- `/Users/keespronk/Python/dexter-telegram`

Typical operator flow with one shared token:

```bash
# Normal live state
./scripts/prod_service.sh start

# Switch to dev testing
./scripts/prod_service.sh stop
cd /Users/keespronk/Python_Dev/dexter-telegram
bun run gateway

# Switch back to prod
# stop dev with Ctrl+C first
cd /Users/keespronk/Python_Dev/dexter-telegram
./scripts/prod_service.sh start
```

## Related BRAIN Files

- [src/gateway/BRAIN.md](src/gateway/BRAIN.md)
- [src/tools/algotrader/BRAIN.md](src/tools/algotrader/BRAIN.md)
- [.dexter/BRAIN.md](.dexter/BRAIN.md)
