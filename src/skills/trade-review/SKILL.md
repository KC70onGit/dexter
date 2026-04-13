---
name: trade-review
description: >
  Review recent live AlgoTrader trades and positions with freshness-aware,
  execution-safe language. Use when the user asks what happened in a trade,
  wants a recap of recent executions, asks for open-risk context, or wants a
  quick post-trade breakdown without placing new orders.
---

# Trade Review Skill

Use the AlgoTrader tools to build a bounded, freshness-aware review of current
or recent trading activity.

## Workflow

1. Call `algotrader_health` first.
2. If health is stale, say so before presenting any live-state conclusion.
3. Call `algotrader_positions` for current exposure.
4. Call `algotrader_trades` for recent realized activity.
5. If the user asks about one ticker specifically, also call `algotrader_chart`.

## Rules

- Never fabricate PnL, entry rationale, or fills that are not present in tool output.
- Treat simulated trades as excluded by default.
- If the trade history is empty, say that directly instead of inferring inactivity.
- Keep explanations compact and operator-oriented: what is open, what closed, what changed, what is stale.

## Output Shape

1. Current health and freshness
2. Open positions summary
3. Recent trades summary
4. Ticker-specific chart context only if relevant
