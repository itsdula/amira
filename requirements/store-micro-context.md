# Store, handlers, and per-step micro-context

Living spec for how qualification data moves through the store. Eraser is retired. Process = brief + this file.

Tables live in Supabase project `amira`. Access is **service_role + RPCs**, not four table reads per turn. Data API is closed (RLS on, no anon policies).

## Why this exists

Requirement **D**: anything saved on one channel is known on the other, including a declined answer. That only holds if every step writes as it goes (brief: not one write at the end) and the assistant can retrieve **facts**, **why they said it**, and **the actual messages**.

A slot like `vehicle=Camry` is not enough. If they said they want a Camry in white for their wife, and they hesitated on black, the next step (and the other channel) needs that narrative — not a re-ask.

**Engine: existing Supabase project `amira`.** Not AF/n8n tables. Voice talks to it via function tools (HTTP). WhatsApp handlers hit the same URLs. Knowledge base stays company RAG only.

## Three trigger handlers

Each inbound event has its own handler. They all resolve to the same `lead_id` and then write the same store shapes.

| Trigger | Event | Handler | Opens with |
| --- | --- | --- | --- |
| **Form submission** | Site POST (`fullName`, `mobileE164`, `vehicle`, `language`, `consentWhatsapp`, `submittedAt`) | Form handler | Upsert lead → write form seed facts → send WA UTILITY template (if consent and not opted out) |
| **Reschedule message** | Scheduler / follow-up fire (no-reply, outside 09:00–21:00 Riyadh, or a booked slot) | Reschedule handler | Load lead → do not re-ask known facts → send follow-up template (window is usually closed) |
| **Customer texting us** | Inbound WhatsApp | Inbound handler | Match `mobileE164` (or create if unknown) → append inbound message to chat log → 24h window opens → resume at `current_step` |

Form is the brief’s only official start. Reschedule and inbound are how a real conversation continues. Inbound is also how a customer who never used the form can appear — treat that as a thin lead until we have name / consent / vehicle.

## External tools

Things outside the model. Handlers *are* entrypoints; the rows below are what a handler or the assistant actually calls. Names match the Tools column on the swimlane.

### WhatsApp / Meta

| Tool | When | What it does |
| --- | --- | --- |
| **Open WA template** | Form handler, first outbound | Pending UTILITY `callback_request_confirm` (`en_US` / `ar`). Same name, two languages. Confirms a callback they already submitted — no “talk about” / channel-choice CTAs (those made Meta recategorize the last one as MARKETING). Implementation: AF callable box `Send WA Template` (`whatsapp-send-template.json`). Input `{ name, phone, vehicle, language }`. Cannot be free-form. Writes the outbound body into `messages`. |
| **Follow-up WA template** | Reschedule handler | Template used when the 24h window is closed (no-reply, outside hours, booked slot). Loads the lead; does not re-ask covered facts. |
| **Closing WA template** | Every terminating path (step 9) | Written recap on WhatsApp even if the whole qualification was on voice: vehicle, grade, price, colours, payment, accessories, next step. If the window is closed, this is a template, not a free-form send. |
| **Inbound WhatsApp** | Customer texting us | Platform inbound webhook, not a send. Inbound handler matches `mobileE164`, indexes the text in `messages` *before* the model replies, opens the 24h window. |
| **can-send / 24h window** | Before every free-form WhatsApp send | Returns whether we are inside the customer-service window (24h after their last inbound). If closed, only a template may go out. |

### Voice

| Tool | When | What it does |
| --- | --- | --- |
| **POST /call** | Channel step, customer chose a call, 09:00–21:00 Asia/Riyadh | Places the outbound call with the Arabic (Najdi) voice card and language already on the lead. Check opt-out and hours first. A no-answer is the common case → scheduler. |
| **Voice logs + latency** | Every voice turn, and on close | Persists transcript snippets, call id, and latency so we can tell our slowness from the platform’s. Feeds `messages` (`channel=voice`) and the close packet. |

### Store

| Tool | When | What it does |
| --- | --- | --- |
| **`ingest_form_submission`** | Form Edge Function | One round-trip: upsert `leads`, append `submissions`, seed facts, return pack + `send_template`. |
| **`record_inbound`** | WhatsApp handler after `message.received` | Match or create lead, append inbound `messages` first, open 24h window, return pack + `next_action`. |
| **`set_channel_choice`** | ask_channel fork, deterministic | `whatsapp` \| `call_now` \| `schedule`. Sets channel/status/`preferred_call_at` (clamps calls to 09:00–21:00 Riyadh), writes `preferred_channel` fact + channel micro-context, returns pack + `call_window`/`dial_now`. |
| **`record_outbound`** | After every send (template, question, reply) | Appends the outbound body to `messages`, stamps `last_outbound_at`. Flows call it right after the messaging POST. |
| **`get_lead_pack`** | Voice dial / any reload | Lead + latest submission + facts + this step’s micro-context + last N messages + `uncovered` + `next_action`. |
| **`upsert_fact`** | Gather writes | Overwrite one coverage key. Decline is a write. |
| **View `lead_latest_submission`** | AF table reads | Latest form seed per `lead_id`. Do not scan `submissions`. |

### Catalogue

| Tool | When | What it does |
| --- | --- | --- |
| **Catalogue tool** | Vehicle, colours, accessories, any price quote | Sync, one conversational turn: model / grade / SAR price / colours-for-that-grade / accessories. Grounding: if it is not in the catalogue, the assistant says so. Do not invent. Shape the payload for one turn, not a website dump. |

### Scheduling and compliance

| Tool | When | What it does |
| --- | --- | --- |
| **Follow-up scheduler** | No-reply, missed call, or outside 09:00–21:00 Riyadh | Queues a later fire into the **Reschedule handler**. Does not send WhatsApp itself. |
| **Opt-out check** | Before every send and every dial | Reads `leads.opted_out`. لا تتصلون علي / “stop messaging me” is global and permanent. One suppression list for WhatsApp and voice. |

### Entry handlers (not model tools)

These receive the outside world. They call the tools above; the model does not.

| Handler | Listens to | Then calls |
| --- | --- | --- |
| **Form handler** | Site POST (form webhook) | Store → Open WA template (if consent and not opted out) |
| **Reschedule handler** | Scheduler fire | Store (load) → Follow-up WA template |
| **Inbound handler** | Customer WhatsApp | Store (`messages` first) → resume assistant at `current_step` |

## WhatsApp × agent (TRIGGERS)

The model does not run on form submit. It runs after the customer’s first inbound (a typed reply **or** a template button tap — both are inbound).

```
form POST → form handler (deterministic)
          → store write
          → UTILITY template  (window still closed)
          → wait

inbound   → inbound handler (deterministic)
          → append messages  (before any model call)
          → load lead + facts + this step’s micro-context + last N lines
          → 24h window opens
          → assistant at current_step
          → tools (catalogue, store, can-send, POST /call, …)
          → free-form WhatsApp send
```

AgenticFlow does not auto-reply unless we wire `message.received` → inbound handler → `POST /chat/message` with the same `channelId` and `threadKey = mobileE164`. Same keys on the send, or each turn is a new billed conversation.

Fetch **before** speech:

1. **Handler preload (sync, no model).** Lead, facts, step micro-context, last N messages. This is how the agent already knows name, vehicle, language, consent.
2. **Tools in the turn.** Catalogue and any other lookup run before the outbound text is sent. If it is not in the catalogue, the assistant says so.
3. **Writes as it goes.** Facts / micro-context / the outbound body land in the store in that same turn.

Still deterministic after first inbound: opt-out, `can-send` (closed window → template only), and the reschedule handler. Do not put those on the model.

## Records

### `leads`

Identity and pointer. One row per phone. Form seed is **not** stored only here — always read `lead_latest_submission`.

- `id`
- `mobile_e164` (unique)
- `full_name`
- `language` (`ar` \| `en`) — do not flip on Latin/Arabizi inside Arabic
- `gender_form` (`m` \| `f` \| `unknown`) — from the name; never guess later
- `consent_whatsapp`
- `opted_out` — global; blocks every send and every dial
- `opened_by` (`form` \| `reschedule` \| `inbound`)
- `current_step` — `channel` \| `vehicle` \| `payment` \| `colours` \| `order_gate` \| `accessories` \| `timing` \| `close` \| `done`
- `current_channel` (`whatsapp` \| `voice` \| `unset`)
- `status` (`awaiting_reply` \| `open` \| `scheduled` \| `in_call` \| `hot` \| `cold`)
- `preferred_call_at`, `outbound_attempts`, `last_inbound_at`, `window_expires_at`
- `updated_at`

### `submissions`

Append-only form posts. Same person can submit twice; the latest row is the seed (vehicle, name, language, consent).

- `id`, `lead_id`, `full_name`, `mobile_e164`, `vehicle`, `language`, `consent_whatsapp`, `submitted_at`, `source` (`form`)

`request_calls` is leftover from init. New writes go through `ingest_form_submission`.

### `facts`

Structured answers. One row per field, overwritten in place, never deleted. A decline is a write.

- `lead_id`
- `key` — `vehicle`, `grade`, `colours`, `payment`, `accessories`, `timing`, `order_now`, plus form seed keys
- `value` (JSON; `null` if declined)
- `declined` (bool)
- `step`
- `channel`
- `at`
- `message_id` — pointer into the chat log

Coverage = every `key` you persist. Re-asking a covered key (including `declined=true`) is a defect.

### `step_contexts` (micro-context)

One document per lead × step. This is the “they asked for a white Camry and talked about their wife” layer.

- `lead_id`
- `step` — `channel` \| `vehicle` \| `payment` \| `colours` \| `order_gate` \| `accessories` \| `timing` \| `close` (same domain as `leads.current_step`; form/reschedule/inbound all seed or resume `channel` first)
- `status` — `empty` \| `in_progress` \| `answered` \| `declined` \| `skipped`
- `facts_owned` — keys this step is allowed to write
- `narrative` — 1–3 sentences, assistant-written, in the customer’s language
- `open_threads` — short notes that are not slots yet (`"wife may drive it"`, `"unsure white vs black"`)
- `message_ids[]` — chat-log rows that produced this context
- `updated_at`

The next step reads the previous step’s micro-context **and** the global `facts` map. It does not start from a blank prompt.

### `messages` (indexed chat log)

Append-only. Every inbound and outbound turn, including templates, voice transcripts, and tool-side system notes you want the other channel to see.

- `id`
- `lead_id`
- `channel` (`whatsapp` \| `voice`)
- `direction` (`in` \| `out` \| `system`)
- `text`
- `lang`
- `step` — step that was active when it was said
- `trigger` — handler that opened this session (`form` \| `reschedule` \| `inbound`)
- `at`
- `meta` — `{ template_name? , call_id? , latency_ms? }`

**Indexes (required):**

- `(lead_id, at)` — replay
- `(lead_id, step)` — “what did they say while we were on colours?”
- full-text on `text` — “white”, “wife”, “Camry”, Arabizi variants

Retrieval for a turn: last N messages + this step’s micro-context + uncovered facts. Do not dump the whole log into the model.

## Trigger-step micro-context (in progress)

`step = triggers`

| Handler | Facts it may write | Narrative it should capture | Chat log |
| --- | --- | --- | --- |
| Form | `full_name`, `mobile_e164`, `vehicle` (seed from page), `language`, `consent_whatsapp` | Where they came from (model page), language they picked, consent | Outbound open template |
| Reschedule | none new unless the template reply arrives in the same turn | Why we came back (no-reply / hours / booked slot), what was already covered | Outbound follow-up template |
| Inbound | seed if new lead; else none | First inbound gist (“asking about Camry white”), window now open | The inbound message, indexed immediately |

After any of the three, `current_step` is `channel` until they pick WhatsApp / call now / schedule. `get_lead_pack` / `record_inbound` return `next_action`:

| `next_action` | Meaning |
| --- | --- |
| `ask_channel` | First inbound (or channel still `unset`). One question: chat, call now, or schedule. |
| `gather` | Channel chosen. Qualification sequence. |
| `stop_opted_out` | Do not send, do not dial. |
| `already_closed` | HOT/COLD already written. Don't re-qualify. |

## Later steps (stubs — fill when that band is in progress)

| Step | Facts owned | Micro-context should hold |
| --- | --- | --- |
| channel | `current_channel`, preferred call time | Why they picked chat vs call |
| vehicle | `vehicle`, `grade` | Enquiry source, what they compared |
| payment | `payment` | Finance hesitation; no silent exit yet (gap) |
| colours | `colours` (ranked 1–3, per grade) | Preference vs availability |
| order_gate | `order_now` | Yes ≠ HOT; No → COLD, no accessories |
| accessories | `accessories` | Only after Yes |
| timing | `timing` | Payment × timing; campaign mention if real |
| close | `status`, call details | Final summary payload for the WA template |

## Write rules

1. A step writes `facts` + its `step_contexts` row + any new `messages` in the same turn.
2. Declined answers are facts.
3. Handlers never share code paths that skip the store write.
4. Opt-out is checked before every send and every dial; it is a fact on the lead.
5. Do not invent catalogue values to fill a fact.
