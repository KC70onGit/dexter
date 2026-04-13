# .dexter BRAIN

This folder is the local Dexter runtime state directory.

Most contents here are machine-local and intentionally ignored by Git.

## What Belongs Here

- gateway config
- local safety counters
- debug logs
- session state
- scratchpad artifacts
- memory database
- Telegram audit logs

## Important Files

- `gateway.json`
  Local gateway runtime policy and channel config
- `telegram-safety.json`
  Daily token and confirmed-trade counters
- `telegram-trade-audit.jsonl`
  Audit log of prepared/confirmed/cancelled Telegram trade actions
- `gateway-debug.log`
  Gateway-side debug output
- `sessions/`
  Session metadata/state
- `memory/index.sqlite`
  Persistent memory store
- `scratchpad/`
  Local run artifacts

## Git Policy

Almost everything in `.dexter/` should stay local-only.

The only file intended to be tracked here is this documentation file:

- `.dexter/BRAIN.md`

Runtime files like `gateway.json`, `telegram-safety.json`, and audit/session artifacts should not be committed from normal local operation.

## Operator Notes

- deleting `telegram-safety.json` resets daily counters
- deleting `sessions/` resets stored session metadata
- deleting `gateway-debug.log` is safe
- deleting `telegram-trade-audit.jsonl` removes historical audit trace, so do that only deliberately

## Prod/Dev Expectation

Both dev and prod checkouts should have their own separate `.dexter/` runtime state.

Do not share this folder between environments.
