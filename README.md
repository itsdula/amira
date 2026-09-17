# Amira — bilingual WhatsApp + voice assistant for KSA automotive retail

Amira qualifies Changan Saudi Arabia leads over WhatsApp and phone calls, in
Najdi Arabic or English: channel choice → vehicle → payment → colours → order
gate → accessories → timing → close. Built as small services around one shared
lead store, not one giant flow.

**Spec (source of truth):** `requirements/Practical assessment — bilingual WhatsApp + voice assistant for KSA automotive retail.md`
and the data contract `requirements/store-micro-context.md`.
**Agent onboarding:** `AGENT-HANDOFF.md`. **Concerns / bugs:** file them in `tickets/`.

## How it runs (30 seconds)

```
Form (web/) ──► request-call fn ──► ingest_form_submission ──► WA template (AF init flow)
Customer replies on WhatsApp ──► AF inbound flow ──► record_inbound (store first)
   ├─ keyword channel choice ──► set_channel_choice ──► confirm text ──► dial if call_now
   └─ anything semantic ──────► inbound-brain fn: model → validate actions → write store → reply
"Call now" (in 09:00–21:00 Riyadh) ──► POST /call ──► Voice Assistant rings the customer
Call ends ──► AF end-of-call report ──► voice-hub fn: transcript + validated facts → store
```

Two LLM surfaces, both tuned **only** in the AgenticFlow dashboard system
messages (each prompt is split "tune freely" / "machine contract — don't
edit"): **WhatsApp Assistant** (`8ef58e44-…`, drives `inbound-brain`) and
**Voice Assistant** (`bb7401d6-…`, realtime calls). The Edge Functions inject
per-turn state (`[CONTEXT]`, call variables), never style.

## Repo map — every folder and file

### Root

| File | What it is |
| --- | --- |
| `README.md` | This file. |
| `AGENT-HANDOFF.md` | Working context for the next AI agent: locked decisions, AF platform facts learned the hard way, built inventory, next work. Read before touching anything. |
| `.env.example` | Documents every secret: local `.env` keys (AF API key/base URL, form webhook) and the Supabase Edge Function secrets (never in files). |
| `.gitignore` | Ignores `.env`, `node_modules/`, `supabase/.temp/`, and `web/` (own repo). |
| `.env` | Local secrets (untracked, never commit). |

### `requirements/` — the spec

| File | What it is |
| --- | --- |
| `Practical assessment — ….md` | The assessment brief (A–H requirements). The product definition. |
| `store-micro-context.md` | The data contract: tables, RPCs, step/fact ownership, micro-context rules. Any process change lands here first. |

### `supabase/` — the store and the brains

| Path | What it is |
| --- | --- |
| `config.toml` | Local CLI config; declares `verify_jwt=false` for the three functions (each does its own auth). |
| `migrations/20260913090000_create_request_calls.sql` | First slice: raw form submissions table (kept for history/backfill). |
| `migrations/20260914120000_lead_store.sql` | The lead store: `leads`, `submissions`, `facts`, `step_contexts`, `messages`, view `lead_latest_submission`, RPCs `record_inbound`, `get_lead_pack`, `upsert_fact`, `ingest_form_submission`, `lead_next_action`, `lead_pack_for`. RLS on everything; service-role only. |
| `migrations/20260914160000_channel_choice_outbound.sql` | RPCs `set_channel_choice` (channel + 09:00–21:00 Riyadh clamp + `dial_now` flag) and `record_outbound` (log what we sent). |
| `migrations/20260917210000_normalize_mobile.sql` | `normalize_mobile()` folded into every RPC — inbound `966…` becomes `+966…` before any constraint sees it. |
| `functions/request-call/index.ts` | **Init service.** Receives the public form POST, calls `ingest_form_submission`, fires the AF template flow when consent allows. |
| `functions/inbound-brain/index.ts` | **The WhatsApp brain.** `{pack, text}` → model (AF assistant first, OpenAI-compatible fallback, deterministic questions if neither) → `validateActions` → write store synchronously → reply. Also owns the **dialer**: a validated `call_now` choice inside hours triggers `POST /call`. Auth: functional service-key probe. Every turn writes a `brain_audit` row (provider, applied/rejected, latency). |
| `functions/inbound-brain/ASSISTANT_PROMPT.md` | The WhatsApp Assistant's installed system prompt (tune/contract halves), assistant ids, recreate instructions. |
| `functions/voice-hub/index.ts` | **Voice ingest.** Receives the assistant's end-of-call report (HMAC-verified), logs transcript+summary to `messages` (channel `voice`), writes `analysis.structuredData` facts through the same `checkFactValue` validation as chat, sets name+gender if new. |
| `functions/voice-hub/VOICE_ASSISTANT.md` | The Voice Assistant's installed prompt, config table, extraction schema, dial-path explanation. |
| `functions/_shared/brain-contract.ts` | The action contract: types, per-step fact allowlists (`FACTS_OWNED`), legal step transitions, catalogue-grounded value checks. Pure functions — the LLM proposes, this decides. |
| `functions/_shared/catalogue.ts` | GENERATED from the scrape (`tools/catalogue/emit-module.mjs`). Models/grades/prices/colours + lookup helpers. Do not hand-edit. |
| `functions/_shared/gender.ts` | `guessGender(name)` — list + suffix heuristics, honest `unknown`. |

Deploys go through the Supabase MCP (`deploy_edge_function`) or CLI. Function
secrets (dashboard → Edge Functions → Secrets): `AGENTICFLOW_API_KEY`,
`BRAIN_AF_ASSISTANT_ID`, `VOICE_ASSISTANT_ID`, `VOICE_HUB_SECRET`
(+ optional `BRAIN_API_KEY`/`BRAIN_MODEL`/`BRAIN_API_URL` fallback).

### `flows/` — AgenticFlow automation

| Path | What it is |
| --- | --- |
| `build-inbound-flow.mjs` | Deterministic generator for the inbound flow JSON. Edit this, never the JSON. Bakes channel/assistant/phone-number ids. |
| `amira-inbound-whatsapp.json` | GENERATED import file (SHARED wrapper, Manual-Trigger-first per AF import rules). Re-import after regeneration. |
| `RECIPES.md` | Import steps, wiring, node-by-node rebuild recipes, mermaid diagram, test curls, reset-test-data SQL. Start here for anything flow-related. |
| `validate_flow.py` | Vendored import validator (from the assessing team's repo). Run before delivering any flow file. |
| `snippets/prep_inbound.js`, `parse_channel.js`, `build_confirm.js` | Paste-ready Code-node sources (Arabic decoded) for manual rebuilds. Generated. |
| `samples/message-received.text-ar.json`, `.text-en.json`, `.button-confirm.json` | Inbound webhook test payloads (Arabic text, English "call me", template button tap). |
| `samples/contact-opted-out.json` | Platform opt-out event payload. |
| `samples/form-webhook.ar.json`, `.en.json` | What `request-call` POSTs to the init flow — paste into its test panel. |

### `knowledge/` — RAG sources

| File | What it is |
| --- | --- |
| `company.md` | Company facts for the KB **Amira** (`c92002e3-…`). |
| `catalogue-vehicles.md` | Vehicle summary for the KB — deliberately *not* the raw JSON, so spare-part prices can't leak into car quotes. |

### `tools/` — build-time tooling

| Path | What it is |
| --- | --- |
| `catalogue/scrape.mjs` + `lib/` | Polite scraper for changan-ksa.com (robots-aware, sitemap-driven). `README.md` inside explains the pass. |
| `catalogue/out/catalogue.json` | The scraped catalogue — the single source of truth for prices. |
| `catalogue/raw/2026-09-13/` | The raw fetched pages + fetch log from the scrape date (provenance for every quoted price). |
| `catalogue/emit-module.mjs` | Regenerates `supabase/functions/_shared/catalogue.ts` from the JSON. |
| `agenticflow-mcp/index.mjs` + `catalog.json` | Local MCP server wrapping the AgenticFlow API + docs (this is the `project-0-amira-agenticflow` MCP in Cursor). `generate-catalog.mjs` rebuilds the operations catalog. |

### `tickets/` — the ticketing system

File a concern, the next agent picks it up. `tickets/README.md` explains the
workflow and carries the **routing map** (symptom → which component to look
at); `tickets/TEMPLATE.md` is the form. One file per ticket, numbered.

### `.cursor/` — agent configuration

| Path | What it is |
| --- | --- |
| `rules/confirmed-process-steps.mdc` | Locked process: services stay split, spec files are the source of truth. |
| `rules/store-micro-context.mdc` | Data-contract rules every agent must follow (write-as-you-go, facts are coverage, no invented tools). |
| `rules/tickets.mdc` | Points every agent session at `tickets/`. |
| `skills/amira-create-wa-template-flow/` | Skill that generates WA template-send subflows (`SKILL.md`, flow template, input schema, generator script). |
| `mcp.json` | Wires the local AgenticFlow MCP into Cursor. |

### `index.html` — the public form (GitHub Pages)

The lead form, served by GitHub Pages straight from this repo's root. POSTs to
the `request-call` function with the publishable key (intentional). The local
`web/` folder is the old standalone checkout of the same page — gitignored;
edit the root `index.html`.

## Live runtime inventory (not in this repo)

- **Supabase project** `amira` (`tmewbswbhnmuuomdfewq`, ap-south-1): the store + three Edge Functions.
- **AgenticFlow workspace** (UAE region, `api.ae.agenticflow.studio`): WhatsApp channel `160e6c61-…` (+49 681 93784711), init template flow, imported inbound flow, KB **Amira**, assistants **WhatsApp Assistant** `8ef58e44-…` + **Voice Assistant** `bb7401d6-…`, phone number `a76efc61-…`.
- **Meta templates**: `callback_request_confirm` (en_US / ar). Follow-up + closing recap templates not yet submitted.

## Testing

`flows/RECIPES.md` has the full loop: reset SQL (`truncate public.leads cascade`),
sample payload curls, and the verification queries (`brain_audit` rows carry
provider, applied/rejected actions, and latency per turn).

## What's not built yet

Ghost scheduler (re-engage silent leads, dial `preferred_call_at`), close
service (recap + hot/cold handoff), Najdi register gate + eval replay, native
WhatsApp tappable buttons. Current open items live in `tickets/`.
