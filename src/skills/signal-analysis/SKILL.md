---
name: signal-analysis
description: >
  Analyze current live AlgoTrader signals and scanner state with freshness-aware
  reasoning. Use when the user asks what the system currently likes, whether a
  ticker is active, what signals are live right now, or wants a quick situational
  read before deciding on a trade.
---

# Signal Analysis Skill

Use the live AlgoTrader read tools to answer signal-state questions without
overreaching beyond the current runtime data.

## Workflow

1. Call `algotrader_health`.
2. If health is stale or `NO_DATA`, say that first and downgrade confidence.
3. Call `algotrader_signals`.
4. If the user names a ticker, check whether it appears in the signal set.
5. If the user wants visual context, call `algotrader_chart` for that ticker.

## Rules

- Never treat a stale signal set as fresh.
- Never imply execution permission from signal presence alone.
- Keep live-state claims tied to the returned tool data.
- If no signals are active, say so directly.

## Output Shape

1. Freshness and health
2. Active signal summary
3. Ticker-specific interpretation if requested
4. Any caution about stale or missing data
