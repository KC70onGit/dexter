# How to Run Dexter

```bash
cd <dexter-telegram-repo>
bun run start
```

```bash
Telegram Gateway
cd <dexter-telegram-repo>
bun run gateway
```


For **watch mode** (auto-restarts on file changes):
```bash
bun run dev
```

---

# Dexter: Local Customizations & Fixes

> **⚠️ NOTE: This is the Telegram Bridge checkout (`dexter-telegram`).**
> **Use the active environment's repo root, not a hardcoded absolute path.**

This document tracks local modifications made to the clean Dexter GitHub pull to ensure things run smoothly and API keys are fully functional.

## Telegram Trading Buddy Bridge (FIX-177)

This checkout now carries the Telegram bridge work for the AlgoTrader trading-buddy plan.

- Telegram transport lives under `src/gateway/channels/telegram/`
- local gateway config is `.dexter/gateway.json`
- the live bot token is read from `.env` / `TELEGRAM_BOT_TOKEN`
- read-only AlgoTrader tools live under `src/tools/algotrader/`
- guarded write preparation uses Telegram inline confirmation buttons and then POSTs to Python-owned `/api/trade`

### Current safety model

- Telegram inbound access is fail-closed unless an allow-list is configured
- long replies are HTML-escaped and chunked safely for Telegram
- trade requests are blocked when health is stale, `NO_DATA`, or `MARKET_CLOSED`
- trade requests are heartbeat-gated and policy-gated through `.dexter/gateway.json`
- write confirmations are audited to `.dexter/telegram-trade-audit.jsonl`
- daily Telegram usage / confirmed-trade counters are persisted in `.dexter/telegram-safety.json`

### Local dev runtime

- `bun run gateway` starts the Telegram bridge
- from the `dexter-telegram` repo root, `python3 ../algotrader/monitor_server.py --host 127.0.0.1 --port 8787` provides the local AlgoTrader REST surface used by the bridge when `algotrader` is checked out as a sibling repo
- this bridge is now validated for:
  - Telegram chat end-to-end
  - positions / health / signals / trades read flows
  - guarded trade-request refusal when market/health policy is unsafe

### Known remaining live proof

- the open-market happy path for `Confirm trade` still needs to be proven while AlgoTrader health is fresh and `session_state == MARKET_OPEN`

## 1. Environment & API Key Setup
Created the `.env` file (from `env.example`) and populated it to enable Dexter's advanced autonomous features:
- **`EXASEARCH_API_KEY`**: Enabled live web search for gathering news and macro-economic data.
- **`FINANCIAL_DATASETS_API_KEY`**: Specified for financial dataset access. *(Note: See point 3 regarding how the codebase currently handles this).*
- **`X_BEARER_TOKEN`**: Enabled the `x_search` tool for real-time Twitter/X sentiment analysis and social insights.

## 2. Bug Fix: Initializing `yahoo-finance2` (v3 Upgrade)
**File changed:** `src/tools/finance/free-api.ts`
- **Issue:** The Dexter repository was attempting to import the `yahoo-finance2` library using a v2 syntactical import (`import yahooFinance from 'yahoo-finance2'`). However, the `package.json` installs `^3.13.2`. This version mismatch caused the application to crash immediately when executing any financial queries.
- **Fix Applied:** Modified the import statement to properly instantiate the version 3 class instance.
  ```typescript
  // Old code:
  // import yahooFinance from 'yahoo-finance2';
  
  // New code:
  import YahooFinance from 'yahoo-finance2';
  const yahooFinance = new YahooFinance();
  ```

## 3. Note on Financial Datasets Interception
**File observed:** `src/tools/finance/free-api.ts`
- **Behavior:** The upstream Dexter repository recently implemented `free-api.ts` as a hardcoded "Drop-in replacement for financialdatasets.ai API" (marked internally as `FIX-042b: Zero cost, no API keys required`). 
- **Impact:** Even though `FINANCIAL_DATASETS_API_KEY` is proudly set in `.env`, the system by default currently routes requests (Income statement, Balance Sheet, Cash Flow, etc.) through the `free-api.ts` script—which scrapes Yahoo Finance and SEC EDGAR databases instead of burning through your paid credits at `financialdatasets.ai`.

## 4. Iteration Budget Awareness (Prompt Fix)
**Files changed:** `src/agent/agent.ts`, `src/agent/prompts.ts`
- **Issue:** The agent had no awareness of how many iterations it had used or had remaining. On complex queries it would keep exploring broadly until the hardcoded `maxIterations: 10` cap cut it off, wasting tokens and returning *"Reached maximum iterations…"* with no answer.
- **Fix Applied:** Injected an iteration budget counter into every iteration prompt (`buildIterationPrompt`). The agent now sees how many steps remain and receives escalating urgency cues:
  - **≤ 4 steps left** → `🔶 Start wrapping up`
  - **≤ 2 steps left** → `⚠️ You MUST deliver your final answer NOW`
- **Result:** The 10-iteration cap stays the same (no extra token spend), but the agent converges on a final answer instead of running out of runway.
