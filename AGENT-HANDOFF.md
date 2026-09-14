# Amira — agent handoff

You are supporting **Dula** on **Amira**: a bilingual (AR/EN) WhatsApp + voice assistant for **KSA automotive retail (Changan)**. Toyota/ALJ is excluded. Workspace: `/Users/dula/Dev/amira`.

Speak like a peer. He knows RAG vs per-lead memory; do not re-explain that. Do not dump secrets or `.env`. Do not run long-lived localhost servers that can list the repo (`.env` leak risk). The monorepo **is** a git repo now and will be pushed to GitHub — keep it credential-clean (`.gitignore` covers `.env`, `web/`). Do not use Vercel unless he asks. Do not invent later-step facts or new external tools without adding them to `requirements/store-micro-context.md`.

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

- Public form is **`web/`** (own git repo, `https://github.com/itsdula/amira`, GitHub Pages). Not an Edge Function HTML (Supabase GET `text/html` rewrite). Not the Amira monorepo.
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

**widget-simple.json:** Catch Webhook → `POST /chat/message` (`channelId` = widgetId, `threadKey` = sessionId) → POST `replyApiUrl` with `replyToken`. Demo widget bot.

**whatsapp-messaging.json:** Catch Webhook → `message.received` → `GET can-send` → if closed, dummy `order_confirmation` (not a park queue) → if open and text, chat then `type: text` to `senderIdentifier`. Audio/else empty. Template for understanding AF, not the product inbound handler.

## Store (built)

Tables: `leads`, `submissions`, `facts`, `step_contexts`, `messages`. View: `lead_latest_submission`. RPCs (service_role): `ingest_form_submission`, `record_inbound`, `set_channel_choice`, `record_outbound`, `get_lead_pack`, `upsert_fact`. Form Edge Function writes via ingest (not `request_calls`). Pack `next_action`: `ask_channel` \| `gather` \| `stop_opted_out` \| `already_closed`.

## Flows (repo `flows/`)

`flows/amira-inbound-whatsapp.json` — generated by `flows/build-inbound-flow.mjs` (rerun after edits; do not hand-edit). Wiring, node recipes, and test curls: `flows/RECIPES.md`. Paste-ready test payloads: `flows/samples/`. Needs AF variables `SUPABASE_SERVICE_ROLE_KEY` + `AMIRA_CHAT_ASSISTANT_ID` and the channel `webhookUrl` pointed at the flow. A live workspace API key was scrubbed from `whatsapp-messaging.json` (replaced with the variable reference) — rotate that key in the AF dashboard if it is still active.

**Import ground truth:** [AC-Group2/agenticflow-studio](https://github.com/AC-Group2/agenticflow-studio) — the assessing team's own skills repo (their product is also called Amira). `activepieces-flow-builder` skill: SHARED wrapper + `metadata.externalId`, schema 22, **first piece must be a Manual Trigger** (webhook-first imports produce an empty trigger — swap in the UI after import), every step needs `lastUpdatedDate`/`sampleData`/`propertySettings`, code steps are isolated-vm (no fetch/npm). Validator vendored at `flows/validate_flow.py` — run it before delivering any flow file. Their `agenticflow-api` skill has the full OpenAPI spec; `reference/agenticflow-assistant.md` documents the voice-assistant export shape (useful for the voice slice). Caveat: `.cursor/skills/amira-create-wa-template-flow` generates a callableFlow-first flow — same import risk; if its import fails, use its snippets (that is what they are for).

## Catalogue (done)

`tools/catalogue/` → `tools/catalogue/out/catalogue.json`. AF Files: `catalogue.json`. KB **Amira** (`c92002e3-d26a-46e7-b72c-3c3fbcae19c7`): `company.md` + `catalogue-vehicles.md` (not the JSON — RAG must not mix spare-part SAR into car quotes). Still quote from the JSON/tool at gather time. CS 35 Plus Trend **70,900** incl. VAT. Do not invent catalogue values.

## Working agreements

- Eraser is retired. Brief + `requirements/store-micro-context.md` are the spec.
- Parent `/Users/dula/Dev/amira` is **not** a git repo; only `web/` is.
- Prefer exact AF node recipes over invalid import JSON; import is flaky.
- Never commit API keys. Prefer workspace variables.
- Do not start extra hosting. Push `web/` only when he asks.
- Delete leftover deployed `request-call-form` in dashboard if it still exists (CLI undeploy needed login).
- Treat Dula’s AF JSON as a **tool to learn**, not a finished product to nitpick against the brief unless he asks.

## Suggested next work (when he says go)

1. Import `flows/amira-inbound-whatsapp.json`, set variables, wire channel `webhookUrl` (see `flows/RECIPES.md`).
2. Submit the two missing Meta UTILITY templates (follow-up nudge + closing recap) — review time blocks ghost and recap.
3. Create the chat assistant (KB Amira, Najdi prompt), paste its id into `AMIRA_CHAT_ASSISTANT_ID`.
4. Gather fact-writing (assistant tools or own harness), then dialer/voice, ghost scheduler, close service, evals, latency report.
