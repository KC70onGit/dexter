# AlgoTrader Tools BRAIN

This folder is the typed bridge between `dexter-telegram` and the Python AlgoTrader monitor server.

## Purpose

These tools let Dexter read live trading state and stage guarded trade requests without directly owning execution logic.

The design principle is:

- Python/AlgoTrader remains the source of truth
- Dexter reads from HTTP endpoints
- Telegram trade requests are prepared and then POSTed back into Python-owned flow

## Default Base URL

Unless overridden, the client uses:

```text
http://127.0.0.1:8787
```

Env override:

- `ALGOTRADER_BASE_URL`

## Core Client

Main file:

- `client.ts`

Responsibilities:

- normalize the base URL
- enforce request timeout
- parse JSON safely
- normalize health/chart/trades payloads into stable envelopes
- expose whether `session_state` is authoritative vs stale/non-authoritative
- normalize `/api/status` into broker connectivity interpretation (FIX-185)
- submit guarded trade requests to `/api/trade`

Default request timeout:

- `8000ms`

## Tool Files

- `health.ts`
  Reads `/api/health` — use for monitor freshness and session-state questions
- `status.ts`
  Reads `/api/status` — use for IBKR broker/gateway/TWS connectivity questions (FIX-185)
- `positions.ts`
  Reads `/api/positions`
- `signals.ts`
  Reads `/api/signals`
- `trades.ts`
  Reads `/api/trades`
- `chart.ts`
  Reads `/api/chart?ticker=...`
- `request-trade.ts`
  Defines the guarded Telegram trade-request tool
- `index.ts`
  Re-exports the tool constructors/descriptions

## HTTP Endpoints Used

- `GET /api/health`
- `GET /api/status`
- `GET /api/positions`
- `GET /api/signals`
- `GET /api/trades`
- `GET /api/chart?ticker=...`
- `POST /api/trade`
- `GET /api/autotrade-status`

## Tool Routing Rules (FIX-185)

There are two distinct read surfaces for stack health:

| Question type | Tool to use |
|---|---|
| "Is the monitor up / fresh?" | `algotrader_health` |
| "What session are we in?" | `algotrader_health` |
| "Is IBKR up?" | `algotrader_status` |
| "Is the engine connected?" | `algotrader_status` |
| "Can I trade right now?" | **both** |
| "Is the stack healthy?" | **both** |

Key distinction:

- `/api/health` is the **monitor/session** source of truth
- `/api/status` is the **broker/runtime** source of truth
- these two can disagree — e.g., monitor can be fresh while IBKR is offline, or IBKR can be connected while the monitor snapshot is stale

## Safety Model

Trade writes are intentionally indirect.

Dexter does not bypass Python risk logic.

Instead:

1. Telegram user asks for a trade
2. Dexter prepares a staged request
3. Telegram confirmation token is required
4. health/policy/heartbeat checks are re-evaluated
5. approved request is submitted to Python-owned `/api/trade`

## Operational Checks

Fast connectivity check:

```bash
curl -sf http://127.0.0.1:8787/api/health
curl -sf http://127.0.0.1:8787/api/status
```

If those endpoints fail, these tools will fail too.

Health nuance:

- stale `MARKET_CLOSED` should be treated as a stale monitor snapshot, not proof the exchange is currently closed
- `NO_DATA` means live session state is unavailable; it is not an exchange-hours oracle
- `client.ts` now emits `monitor_state`, `session_state_authoritative`, `market_hours_inference_allowed`, and `operator_guidance` to make that distinction explicit for the agent

Status nuance (FIX-185):

- `broker_state` is a derived enum: `connected`, `gateway_only`, `unreachable`, or `unknown`
- `broker_state_authoritative` is false when the underlying snapshot is stale
- `operator_guidance` provides a human-readable explanation tying gateway reachability + engine connection + staleness together

## Most Important File

If only one file is read first, read:

- `client.ts`
