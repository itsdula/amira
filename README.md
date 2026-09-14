# Amira — bilingual WhatsApp + voice assistant (Changan KSA)

Qualifies "request a call" leads for Changan Saudi Arabia over WhatsApp and outbound voice, in Najdi Arabic and English, on AgenticFlow with a Supabase lead store. Built against the practical-assessment brief in `requirements/`.

Live form: [itsdula.github.io/amira](https://itsdula.github.io/amira/) (source: [github.com/itsdula/amira](https://github.com/itsdula/amira)).

## How it runs

```
form (web/) ──POST──▶ Edge Function request-call
                        │  ingest_form_submission()          Supabase (store)
                        │  → leads / submissions / facts     leads · submissions · facts
                        └─▶ AF init flow ──▶ WA template     step_contexts · messages
                                                             RPCs: get_lead_pack, record_inbound,
customer replies                                             set_channel_choice, record_outbound,
  │                                                          upsert_fact, ingest_form_submission
  ▼
WA channel webhookUrl ──▶ AF inbound flow
  1. record_inbound()   — index message first, open 24h window, get lead pack
  2. route next_action  — ask_channel (deterministic) | gather (assistant) | stop
  3. send + record_outbound()
```

Three services, kept separate on purpose: **init** (form → template), **inbound** (everything the customer sends), **ghost/reschedule** (scheduler → follow-up template; not built yet). One store row per phone is the shared memory for WhatsApp *and* voice — requirement D.

## Repo layout

| Path | What |
| --- | --- |
| `requirements/` | The brief + the store/data contract (`store-micro-context.md`) |
| `supabase/` | Migrations (schema + RPCs) and the `request-call` Edge Function |
| `flows/` | AF flow JSONs, `build-inbound-flow.mjs` generator, node recipes, test samples |
| `tools/catalogue/` | Changan KSA scraper → `out/catalogue.json` (10 models, 202 priced spare parts) |
| `knowledge/` | KB sources uploaded to AF (`company.md`, `catalogue-vehicles.md`) |
| `web/` | Form page — separate repo, GitHub Pages (ignored here; see `.gitignore`) |
| `whatsapp-send-template.json` | Init template-send box (live in AF) |
| `whatsapp-messaging.json`, `widget-simple.json` | Reference exports used to learn AF node shapes |

## Store

Supabase project `amira` (`tmewbswbhnmuuomdfewq`). Data API is closed (RLS, no anon grants); everything goes through service-role RPC calls — one round-trip per event, not four table reads. Contract, tables, and write rules: `requirements/store-micro-context.md`.

Apply schema to a fresh project: `supabase db push` (or run `supabase/migrations/*.sql` in order).

## AgenticFlow

- WhatsApp channel `160e6c61-174a-4de1-b338-ce2e27666c37` (+49 681 93784711).
- Knowledge base **Amira** (`c92002e3-d26a-46e7-b72c-3c3fbcae19c7`): company facts + vehicle catalogue summary. The full `catalogue.json` is deliberately *not* in the KB — spare-part prices must not leak into car quotes.
- Import/wiring/test instructions: `flows/RECIPES.md`. Workspace variables required: `AgenticFlow_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `AMIRA_CHAT_ASSISTANT_ID`.

## Fire the trigger (no form needed)

```bash
curl -X POST https://tmewbswbhnmuuomdfewq.supabase.co/functions/v1/request-call \
  -H "Content-Type: application/json" \
  -d '{"fullName":"Mohammed Alotaibi","mobileE164":"+9665XXXXXXXX","vehicle":"CS-35-PLUS","language":"en","consentWhatsapp":true}'
```

Sends reach real phones — use your own number. Flow-test payloads (paste instead of typing): `flows/samples/`.

## Templates (Meta)

| Name | Category | Languages | State |
| --- | --- | --- | --- |
| `callback_request_confirm` | UTILITY | `en_US`, `ar` | confirm name/state in dashboard |
| follow-up nudge (ghost) | UTILITY | `en_US`, `ar` | **not submitted — blocks ghost service** |
| closing recap | UTILITY | `en_US`, `ar` | **not submitted — blocks out-of-window recap** |

## Catalogue

```bash
cd tools/catalogue && npm install && npm run scrape   # polite, rate-limited, raw pages saved
```

Grounding rule: every price/grade/colour the assistant says must exist in `out/catalogue.json`. Showroom option packs have no published price — the data says so; the assistant says so.

## Secrets

None committed. `.env` is ignored (`.env.example` lists the keys). AF keys live in workspace variables; Supabase keys in Edge Function secrets. Rotate anything that ever leaked before pushing this repo anywhere public.

## Status / gaps

Done: catalogue + KB, store schema + RPCs, form → template init path, inbound flow (import + wire pending).
Not built: dialer (voice), ghost scheduler, close/recap service, fact extraction during gather, schedule-time capture, Najdi gate, evals, latency reporting. Tracked in `AGENT-HANDOFF.md`.
