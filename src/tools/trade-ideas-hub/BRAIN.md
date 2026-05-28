# Trade Ideas Hub Tools BRAIN

This folder contains Dexter read-only tools over the existing Trade Ideas Hub and
canonical AlgoTrader artifacts.

## Contract

- Python/Trade Ideas Hub remains the source of truth.
- Dexter reads `/api/integrated-pipeline`, `/api/quality-assurance`,
  `/api/opening-session`, and `/api/watchlists` first.
- Integrated Pipeline reads pass `rerank_legacy=0` so Dexter cannot trigger the
  Hub's compatibility/canonical artifact writer.
- If the Hub API is unavailable, Dexter falls back to local artifacts under
  `ALGOTRADER_REPO_ROOT`.
- Fallback results are marked `source=local_artifact_fallback` and `stale=true`.
- Opening Session fallback is deliberately limited to named opening evidence
  contracts; it must not scan arbitrary `algotrader/runtime/*.json` files.
- QA fallback aggregates the worst existing source-artifact status so a runtime
  `PASS` cannot mask validation `FAIL` evidence.
- Hub QA API results flatten `sections[].checks` so online QA keeps the same
  "why" visibility as local fallback.
- Hub Watchlists API results flatten `tiles[].items` and use
  `summary.total_unique_tickers` for the ticker count.
- These tools never call IBKR, run workflows, write artifacts, route orders, or
  create a second QA verdict.

## Tools

- `trade_ideas_integrated_universe`
  Reads the current Integrated ticker universe and ranked candidates.
- `trade_ideas_quality_assurance`
  Summarizes existing daily/runtime QA truth and validation checks.
- `trade_ideas_opening_session`
  Summarizes opening-session candidates and preopen evidence.
- `trade_ideas_watchlists`
  Reads generated watchlist matrices/files.

## Tests

- `client.test.ts` covers Hub API success, Integrated local fallback, QA
  fallback preserving the existing source artifact verdict, QA section checks,
  and Watchlists tile-item normalization.
- `../registry.test.ts` proves the tools are registered and that MR routing is
  no longer advertised for broad market questions.
