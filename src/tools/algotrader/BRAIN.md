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
- submit guarded trade requests to `/api/trade`

Default request timeout:

- `8000ms`

## Tool Files

- `health.ts`
  Reads `/api/health`
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
- `GET /api/positions`
- `GET /api/signals`
- `GET /api/trades`
- `GET /api/chart?ticker=...`
- `POST /api/trade`
- `GET /api/autotrade-status`

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
```

If that endpoint fails, these tools will fail too.

Health nuance:

- stale `MARKET_CLOSED` should be treated as a stale monitor snapshot, not proof the exchange is currently closed
- `NO_DATA` means live session state is unavailable; it is not an exchange-hours oracle
- `client.ts` now emits `monitor_state`, `session_state_authoritative`, `market_hours_inference_allowed`, and `operator_guidance` to make that distinction explicit for the agent

## Most Important File

If only one file is read first, read:

- `client.ts`
