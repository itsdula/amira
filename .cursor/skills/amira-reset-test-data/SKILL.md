---
name: amira-reset-test-data
description: Wipe all rows from all tables in the amira Supabase project between test rounds. Use when Dula asks to reset, wipe, clear, or empty the test data, leads, conversations, or the Supabase store before a new WhatsApp/voice test.
---

# Reset Amira test data

One reusable mechanism, never hand-written SQL: the `reset_test_data()` RPC
(migration `supabase/migrations/20260921120000_reset_test_data.sql`). It
truncates every base table in `public` (`restart identity cascade`) and
returns the per-table row counts from just before the wipe.

## How to run (pick one)

1. **Supabase MCP** (preferred for agents — no local secrets needed):
   `execute_sql` on project `tmewbswbhnmuuomdfewq` with
   `select public.reset_test_data();`
2. **Local script**: `tools/reset-test-data.sh`
   (needs `SUPABASE_SERVICE_ROLE_KEY` in env or `.env`).
3. **SQL editor**: `select public.reset_test_data();`

Report the returned `wiped` counts to Dula as confirmation.

## What it does NOT reset

- **AF assistant thread memory**: `/chat/message` threads are keyed by the
  customer mobile and live on AgenticFlow. `[CONTEXT]` is authoritative so
  stale thread history is usually harmless, but for a fully clean run test
  from a different number.
- AF-side state: templates, channel config, assistants, KB, call logs.
- Auth: the RPC is service-role only; anon/authenticated cannot call it.

## After the wipe

Verification queries and test payloads: `flows/RECIPES.md` ("Reset test
data" section and `flows/samples/`).
