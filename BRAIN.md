# Dexter: Local Customizations & Fixes

This document tracks local modifications made to the clean Dexter GitHub pull to ensure things run smoothly and API keys are fully functional.

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
