# Amira — agent handoff

You are supporting **Dula** on **Amira**: a bilingual (AR/EN) WhatsApp + voice assistant for **KSA automotive retail (Changan)**. Toyota/ALJ is excluded. Workspace: `/Users/dula/Dev/amira`.

Speak like a peer. He knows RAG vs per-lead memory; do not re-explain that. Do not dump secrets or `.env`. Do not run long-lived localhost servers that can list the repo (`.env` leak risk). The monorepo **is** on GitHub (public) — keep it credential-clean (`.gitignore` covers `.env`; never commit keys). Do not use Vercel unless he asks. Do not invent later-step facts or new external tools without adding them to `requirements/store-micro-context.md`.

## Locked process

Eraser band color = **build status**, not sales outcome. Source: [reference process](https://app.eraser.io/workspace/bUY0SvSSIAVT9tETTCHb?diagram=0I4sz5Hv8jirGmtTArx-) (file `bUY0SvSSIAVT9tETTCHb`, diagram `0I4sz5Hv8jirGmtTArx-`). Rule: `.cursor/rules/confirmed-process-steps.mdc`.

| Band | Status |
| --- | --- |
| TRIGGERS | yellow — in progress |
| 2 CHANNEL through 9 CLOSE | gray — pending |
| Confirmed green | **none** |

Never paint a band green. Green HOT / red COLD nodes are lead outcomes, not confirmation. Do not edit a green band unless Dula approves that turn.

**Three handlers stay split:** form, reschedule, inbound. Do not merge them.

Data contract: `requirements/store-micro-context.md`. Every step writes as it goes: `leads` + `facts` + that step’s `step_contexts` + `messages`. A fact is coverage (including declined). Micro-context is narrative + open threads, not only slots. Chat log is append-only; index inbound **before** the model replies.

## Architecture (decided)

- **Store = existing Supabase project `amira`** (`tmewbswbhnmuuomdfewq`, `ap-south-1`). Not AgenticFlow/n8n tables. KB = company RAG only.
- AgenticFlow has **no** leads/memory API. WhatsApp and voice share one lead page (requirement D), keyed by `mobileE164`.
- Turn start: small **sync read** (lead + facts + this step’s micro-context + last N messages). Writes fire-and-forget on voice (do not block speech / narrate plumbing).
- **AF is the pipe** (WhatsApp channel, templates, voice STT/TTS, optional chat). The **harness** (load pack → model → tools → write) should not be a pile of routers. A small Node/Edge Function is the intended brain for inbound; AF **callable boxes** are reusable edges (send template, can-send, HTTP to Supabase).
- Voice cannot read tables in-process. Function tools only POST `server.url`. That URL can be a **sync catch-webhook** or a **Supabase Edge Function**. Same store URLs for WhatsApp handlers and voice tools.
- AF MCP in docs is **docs for Cursor**, not a runtime. You cannot attach MCP to their assistant. Chat/voice tools are HTTP. `POST /chat/message` **is** their harness. Own harness + own model + MCP is OK for **WhatsApp text**; voice stays AF assistant + HTTP tools.
- Knowledge base ≠ lead store. He already knows. Company details go in KB; leads go in Supabase.

## AgenticFlow facts

- Base URL for this workspace: **`https://api.ae.agenticflow.studio`** (not `api.agenticflow.studio`).
- Auth: `X-Api-Key`. Use `{{variables['AgenticFlow_API_KEY']}}` in flows — never bake keys into exports (old `whatsapp-messaging.json` / `widget-simple.json` had a live key; rotate if still there).
- WhatsApp channel (connected, active): id **`160e6c61-174a-4de1-b338-ce2e27666c37`**, display **Amira AI - almost human**, number **+49 681 93784711**. `channelId` is the inbox, not a user/chat; `to` is the customer E.164. Stable until reconnect.
- English Meta locale is always **`en_US`**, never `en`. Arabic is **`ar`**. Form language field may still be `en`/`ar`.
- Inbound WhatsApp: **Meta → AF → POST channel `webhookUrl`** (Catch Webhook). Lead does not hit the flow. If `webhookUrl` is empty, the flow never runs.
- Assistant webhooks (`status-update`, `transcript`, `end-of-call-report`) are **voice lifecycle** on the assistant `server` block — not messaging. Messaging events live on the **channel**. `tool-calls` go to each tool’s URL. `assistant-request` is on the **phone number**.
- Workspace assistant via API: **Forward - 6 digits code** (`1eab5020-8570-43f3-bfd9-4787cdb0318e`), `type: realtime`, `tools: []`, those three voice events, no KB. Widget/WA demo flows referenced `f4e15aeb-…` which **404s** on this workspace. Realtime assistants are not chat-compatible.
- Chat vs send: `POST /chat/message` generates text (nothing to the customer). `POST /messaging/messages` delivers. Bridge: same `channelId` and `threadKey` = `to` (E.164) or each turn is a new billed conversation.
- Templates skip `can-send`. Free-form requires open 24h window. `sent` + `wamid` is not delivered; re-GET the message. Marketing drop: WhatsApp **`#131049`**. Empty body params: **`#131008`**.
- API keys cannot create templates (`messaging.templates.manage` is JWT/dashboard).
- Code sandbox: **no `fetch`, no `require`**. Code only returns objects. HTTP piece sends. Activepieces `{{ name }}` is stolen before AF/Meta see it — fill component `text` in Code from `inputs.*`. `templateVariables` keys cannot be `"1"`/`"2"` (bare identifiers only).
- Callable subflows have no live template dropdown / dynamic fields. That is custom-piece territory.
- Do not copy `metadata.externalId` when generating a new flow (overwrites the live one).

## WhatsApp templates

Meta recategorized sales-y copy (“talk about”, “continue here or call”) from UTILITY → **MARKETING**, then **`#131049`** on a test KSA number. New copy is a **callback confirmation** (receipt + Cancel), no channel-choice CTAs. Channel choice waits until they tap Confirm (inbound opens 24h).

Intended names (drift — confirm in dashboard before sending):

- Spec / Edge Function payload: `callback_request_confirm` with language `en_US` | `ar`
- Dula’s later box used suffixes: `callback_request_confirm_en` / `callback_request_confirm_ar`
- Old marketing (do not keep sending to that test number): `biz_case_start_from_submission` / `_ar`
- `request_a_call` was the first name; not on the channel list last checked

**TRIGGERS only needs the open template.** After inbound, free-form. Follow-up + closing templates exist on the swimlane for later gray bands — do not write them now.

## Form + hosting

- Public form is **`web/index.html`** in this repo, served by the GitHub Pages workflow → [itsdula.github.io/amira](https://itsdula.github.io/amira/). Not an Edge Function HTML (Supabase GET `text/html` rewrite).
- POSTs JSON to `https://tmewbswbhnmuuomdfewq.supabase.co/functions/v1/request-call` with publishable key on the page (intentional).
- Function upserts `request_calls`, then if consent POSTs to `FORM_WEBHOOK_URL` (AF catch/callable). Payload includes `fullName`, `mobileE164`, `vehicle`, `language`, `template`, `templateLanguage`. Test payloads to the box sometimes used `{ name, phone, vehicle, language }` — map carefully.
- `verify_jwt = false` on that function. Do not fail the form 200 if the webhook fails.

## AF workflow patterns (exploration)

**Send Form Submission Template** (keep this shape for all template sends):

1. Data Gather — Callable Flow, advanced sample JSON (`phone` required)
2. Prepare Data — Code `step_2` returns `{ url, method, headers, body, … }` plain objects + `apiKey` from variables
3. Make the Call — HTTP; JSON Body = `{{step_2['output']['body']}}` as an **object**

Skill: `.cursor/skills/amira-create-wa-template-flow/`. Ask for languages (`en` / `en_US` / `ar` / both) and **template names** — never invent them. Then run:

```bash
node .cursor/skills/amira-create-wa-template-flow/scripts/generate.mjs --config path/to/input.json
```

The workspace reference exports (`whatsapp-messaging.json`, `whatsapp-send-template.json`, `widget-simple.json`) were **removed 2026-09-17** — they were learning material, their lessons live in this file and in the generator. Recoverable from git history if ever needed. Key lessons kept: inbound chat flows check `can-send` before free-form sends; `/chat/message` bridges to delivery via same `channelId` + `threadKey`; widget flows POST `replyApiUrl` with `replyToken`.

## Store (built)

Tables: `leads`, `submissions`, `facts`, `step_contexts`, `messages`. View: `lead_latest_submission`. RPCs (service_role): `ingest_form_submission`, `record_inbound`, `set_channel_choice`, `record_outbound`, `get_lead_pack`, `upsert_fact`. Form Edge Function writes via ingest (not `request_calls`). Pack `next_action`: `ask_channel` \| `gather` \| `stop_opted_out` \| `already_closed`.

## Flows (repo `flows/`)

`flows/amira-inbound-whatsapp.json` — generated by `flows/build-inbound-flow.mjs` (rerun after edits; do not hand-edit). Wiring, node recipes, and test curls: `flows/RECIPES.md`. Paste-ready test payloads: `flows/samples/`. Needs AF variables `SUPABASE_SERVICE_ROLE_KEY` + `AgenticFlow_API_KEY` and the channel `webhookUrl` pointed at the flow. The keyword fast path now dials on `dial_now` (`route_dial` → `place_call`; voice assistant + phone number ids baked in the generator) — the regenerated JSON must be re-imported. A live workspace API key once sat in the old `whatsapp-messaging.json` export (since removed) — rotate that key in the AF dashboard if it was never rotated.

**Import ground truth:** [AC-Group2/agenticflow-studio](https://github.com/AC-Group2/agenticflow-studio) — the assessing team's own skills repo (their product is also called Amira). `activepieces-flow-builder` skill: SHARED wrapper + `metadata.externalId`, schema 22, **first piece must be a Manual Trigger** (webhook-first imports produce an empty trigger — swap in the UI after import), every step needs `lastUpdatedDate`/`sampleData`/`propertySettings`, code steps are isolated-vm (no fetch/npm). Validator vendored at `flows/validate_flow.py` — run it before delivering any flow file. Their `agenticflow-api` skill has the full OpenAPI spec; `reference/agenticflow-assistant.md` documents the voice-assistant export shape (useful for the voice slice). Caveat: `.cursor/skills/amira-create-wa-template-flow` generates a callableFlow-first flow — same import risk; if its import fails, use its snippets (that is what they are for).

## Catalogue (done)

`tools/catalogue/` → `tools/catalogue/out/catalogue.json`. AF Files: `catalogue.json`. KB **Amira** (`c92002e3-d26a-46e7-b72c-3c3fbcae19c7`): `company.md` + `catalogue-vehicles.md` (not the JSON — RAG must not mix spare-part SAR into car quotes). Still quote from the JSON/tool at gather time. CS 35 Plus Trend **70,900** incl. VAT. Do not invent catalogue values.

## Working agreements

- Eraser is retired. Brief + `requirements/store-micro-context.md` are the spec.
- The monorepo lives on GitHub at **itsdula/amira** (public; histories merged 2026-09-17). The live form is `web/index.html`, deployed by `.github/workflows/pages.yml` → [itsdula.github.io/amira](https://itsdula.github.io/amira/). `web/` is a normal tracked folder (the old nested `.git` was removed).
- **Check `tickets/` first**: Dula files concerns there; `tickets/README.md` has the symptom → component routing map. Update ticket status as you work.
- Prefer exact AF node recipes over invalid import JSON; import is flaky.
- Never commit API keys. Prefer workspace variables.
- Do not start extra hosting. The form deploys itself on push (Pages workflow).
- Delete leftover deployed `request-call-form` in dashboard if it still exists (CLI undeploy needed login).
- Treat Dula’s AF JSON as a **tool to learn**, not a finished product to nitpick against the brief unless he asks.

## inbound-brain (built)

Edge Function `inbound-brain` (deployed, v2): the model turn for ask_channel misses + all gather turns. `{pack, text, message_id}` → model → executor validates actions (`_shared/brain-contract.ts`: step fact allowlists, legal transitions, catalogue-grounded values via generated `_shared/catalogue.ts`) → writes state sync → returns reply. Rejections audit-logged (`messages.meta.kind=brain_audit` + `provider`/`model_ms`/`total_ms` — latency evidence for G). **Model provider AF-first**: `/chat/message` with assistant **Amira Brain** `8ef58e44-6de1-48ec-8d76-189e8595fd7f` (type `pipeline` — AF's chat-capable type; model gpt-5.4-mini; KB Amira attached; smoke-tested: JSON + grounded price in 2.7s). Static rules + JSON schema live on the assistant, per-turn pack goes in `[CONTEXT]` (`supabase/functions/inbound-brain/ASSISTANT_PROMPT.md`). Secrets: `AGENTICFLOW_API_KEY` + `BRAIN_AF_ASSISTANT_ID`. AF facts learned: assistant types are only `pipeline`/`realtime`; tiers `standard`/`premium`/`gold`; `premium`→realtime-only; pipeline needs model+voice+transcriber (voice/STT schema-required even for chat use). OpenAI-compatible fallback only if AF pair unset (`BRAIN_API_KEY`). No model configured → deterministic fallback questions, flow still works. Auth = service-role key header; `verify_jwt=false`.

## Voice slice (built 2026-09-17)

- **Voice Assistant** (realtime, premium/holly): `bb7401d6-b4ba-45e1-98b2-948a74448ed5`. KB Amira attached. No mid-call tools — facts come from `analysis.structuredData` on the end-of-call report. Prompt + schema doc: `supabase/functions/voice-hub/VOICE_ASSISTANT.md`. **Voice card still English (holly)** — swap to an Arabic card in the dashboard (tier voice cards are dashboard-only).
- **Dialer** exists twice, disjoint paths, one dial max per turn: brain executor (v13; semantic path — `set_channel_choice` returns `dial_now:true` → `POST /call` with pack as `variables`, `lead_id` in `metadata`; phone number id discovered from `GET /phone-number` → `data.phoneNumbers[0]`, cached) and flow fast path (`route_dial` → `place_call` node, ids baked at generation). Workspace phone number: `a76efc61-6055-4fd0-8943-d79e067cc2d4` (+49 sandbox).
- **voice-hub** Edge Function (v1, deployed): receives `end-of-call-report`, verifies `X-Webhook-Signature` HMAC against `VOICE_HUB_SECRET`, logs transcript+summary to `messages` (channel=voice), writes extracted facts through `checkFactValue` (exported from `brain-contract.ts`), sets name+gender if new. Unsigned posts 401 (smoke-tested).
- Secrets still to set (dashboard or CLI): `VOICE_ASSISTANT_ID`, `VOICE_HUB_SECRET` (value printed at creation; also lives on the assistant `server.secret`).
- Prompt tuning model: **AF dashboard is the single tuning surface** for both assistants. Both prompts are split TUNE-FREELY / MACHINE-CONTRACT; the Edge Function only injects per-turn `[CONTEXT]` (state, not style). `STATIC_RULES` in `inbound-brain` is OpenAI-fallback-only, dead code in AF mode.
- API gotchas hit: Cloudflare 1010 blocks python-urllib UA (set any custom UA); `kbRetrievalMode` is tier-forced on premium (omit); inline `{"type":"endCall"}` rejected on create (tools must be ids or accepted inline shapes; add end-call tool from dashboard if wanted).

## Suggested next work (when he says go)

1. Set `VOICE_ASSISTANT_ID` + `VOICE_HUB_SECRET` Edge Function secrets; swap voice card to Arabic; test a call_now turn end-to-end (WhatsApp "اتصلوا علي" → dial → report lands in `messages`).
2. Submit the two missing Meta UTILITY templates (follow-up nudge + closing recap) — review time blocks ghost and recap.
3. Then: ghost scheduler (reads `preferred_call_at` + voice_call_report ended_reason), close service, Najdi gate + evals (replay `brain_audit` rows), latency report from `messages.meta`.
