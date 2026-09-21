#!/usr/bin/env bash
# Wipe all rows from all tables in the amira Supabase project (test resets).
# Thin wrapper over the reset_test_data() RPC — see
# supabase/migrations/20260921120000_reset_test_data.sql.
#
# Usage:  tools/reset-test-data.sh
# Key:    SUPABASE_SERVICE_ROLE_KEY from the environment or ../.env
set -euo pipefail
cd "$(dirname "$0")/.."

KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"
if [ -z "$KEY" ] && [ -f .env ]; then
  KEY="$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env | cut -d= -f2- | tr -d '"' || true)"
fi
if [ -z "$KEY" ]; then
  echo "SUPABASE_SERVICE_ROLE_KEY not found (env or .env)." >&2
  echo "Alternatives:" >&2
  echo "  - SQL editor / Supabase MCP:  select public.reset_test_data();" >&2
  exit 1
fi

curl -sf -X POST "https://tmewbswbhnmuuomdfewq.supabase.co/rest/v1/rpc/reset_test_data" \
  -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
echo
