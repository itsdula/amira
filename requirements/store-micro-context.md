# Store, handlers, and lead selection

Living spec for how qualification data moves through the store. Eraser is retired. Process = brief + this file.

Tables live in Supabase project `amira`. Access is **service_role + RPCs**. Data API is closed (RLS on, no anon policies).

## Why this exists

Requirement **D**: anything saved on one channel is known on the other, including a declined answer. That only holds if every turn writes as it goes (brief: not one write at the end).

One row per phone. Qualification lives as a single JSON object on that row (`leads.selection`). The pack for a turn is that object plus the last N `messages`. The model fills empty keys; code decides which empty key to ask next. Code also writes a clear answer to NEXT ASK from the inbound text when it maps to a catalogue or enum value, so a missing `patch_selection` action cannot drop coverage. There is no facts table and no step_contexts table.

**Engine: existing Supabase project `amira`.** Not AF/n8n tables. Voice talks to it via HTTP. WhatsApp handlers hit the same URLs. Knowledge base stays company RAG only.

## Three trigger handlers

Each inbound event has its own handler. They all resolve to the same `lead_id` and then write the same store shapes. Do not merge them.

| Trigger | Event | Handler | Opens with |
| --- | --- | --- | --- |
| **Form submission** | Site POST (`fullName`, `mobileE164`, `vehicle`, `language`, `consentWhatsapp`, `submittedAt`) | Form handler | Upsert lead → seed `selection.vehicle` → send WA UTILITY template (if consent and not opted out) |
| **Reschedule message** | Scheduler / follow-up fire (no-reply, outside 09:00–21:00 Riyadh, or a booked slot) | Reschedule handler | Load lead → do not re-ask filled keys → send follow-up template (window is usually closed) |
| **Customer texting us** | Inbound WhatsApp | Inbound handler | Match `mobileE164` (or create if unknown) → append inbound message to chat log → 24h window opens → resume from empty keys on `selection` |

Form is the brief’s only official start. Reschedule and inbound are how a real conversation continues. Inbound is also how a customer who never used the form can appear — treat that as a thin lead until we have name / consent / vehicle.

## External tools

Things outside the model. Handlers *are* entrypoints; the rows below are what a handler or the assistant actually calls.

### WhatsApp / Meta

| Tool | When | What it does |
| --- | --- | --- |
| **Open WA template** | Form handler, first outbound | Approved UTILITY `callback_request_confirm_en` / `callback_request_confirm_ar`. Confirms a callback they already submitted. `request-call` sends it with `POST /messaging/messages` (AF API, no canvas). Writes the outbound body into `messages`. |
| **Follow-up WA template** | Reschedule handler | Template used when the 24h window is closed (no-reply, outside hours, booked slot). Loads the lead; does not re-ask filled keys. |
| **Closing WA template** | Every terminating path | Written recap on WhatsApp even if the whole qualification was on voice: vehicle, color, payment, accessories, next step. If the window is closed, this is a template, not a free-form send. |
| **Inbound WhatsApp** | Customer texting us | Meta → AF channel → `POST` our `inbound` Edge Function (`webhookUrl`). Handler matches `mobileE164`, indexes the text in `messages` *before* the model replies, opens the 24h window, then sends the reply via the AF messaging API. |
| **can-send / 24h window** | Before every free-form WhatsApp send | Returns whether we are inside the customer-service window (24h after their last inbound). If closed, only a template may go out. AF matches that window on the mobile **without** a leading `+`. The store still keeps E.164 with `+`. |

### Voice

| Tool | When | What it does |
| --- | --- | --- |
| **POST /call** | Channel step, customer chose a call, 09:00–21:00 Asia/Riyadh | Places the outbound call with the Arabic (Najdi) voice card and language already on the lead. Check opt-out and hours first. A no-answer is the common case → scheduler. |
| **Voice logs + latency** | Every voice turn, and on close | Persists transcript snippets, call id, and latency. Feeds `messages` (`channel=voice`) and the close packet. |

### Store

| Tool | When | What it does |
| --- | --- | --- |
| **`ingest_form_submission`** | Form Edge Function | One round-trip: upsert `leads`, append `submissions`, seed `selection.vehicle`, return pack + `send_template`. |
| **`record_inbound`** | WhatsApp handler after `message.received` | Match or create lead, append inbound `messages` first, open 24h window, return pack + `next_action`. |
| **`set_channel_choice`** | ask_channel fork, deterministic | `whatsapp` \| `call_now` \| `schedule`. Sets channel/status/`preferred_call_at` (clamps calls to 09:00–21:00 Riyadh), sets `current_step` from `selection_next_ask`, returns pack + `call_window`/`dial_now`. |
| **`record_outbound`** | After every send (template, question, reply) | Appends the outbound body to `messages`, stamps `last_outbound_at`. |
| **`inbound` (Edge Function)** | Channel `webhookUrl` | WhatsApp handler. HMAC-verified AF event → `record_inbound` first → keyword channel / gather → AF `POST /messaging/messages` + optional `POST /call`. |
| **`inbound-brain` (Edge Function)** | Debug / curls only | Same model turn as `inbound`, without send. Live traffic does not use this. |
| **`get_lead_pack`** | Voice dial / any reload | Lead (including `selection`) + latest submission + last N messages + `next_ask` + `next_action`. |
| **`patch_selection`** | Gather writes | Merge a JSON patch into `leads.selection`. Empty keys stay null. `order_now=false` forces `accessories="none"`. |
| **View `lead_latest_submission`** | AF table reads | Latest form seed per `lead_id`. Do not scan `submissions`. |
| **`reset_test_data`** | Test rounds only (never product logic) | Truncates every public table. Service-role only. |

### Catalogue

| Tool | When | What it does |
| --- | --- | --- |
| **Catalogue tool** | Vehicle, color, accessories, any price quote | Sync, one conversational turn: model / grade / SAR price / colors for that model / accessories. Grounding: if it is not in the catalogue, the assistant says so. Do not invent. |

### Scheduling and compliance

| Tool | When | What it does |
| --- | --- | --- |
| **Follow-up scheduler** | No-reply, missed call, or outside 09:00–21:00 Riyadh | Queues a later fire into the **Reschedule handler**. Does not send WhatsApp itself. |
| **Opt-out check** | Before every send and every dial | Reads `leads.opted_out`. لا تتصلون علي / “stop messaging me” is global and permanent. |

### Entry handlers (not model tools)

| Handler | Listens to | Then calls |
| --- | --- | --- |
| **Form handler** | Site POST (`request-call`) | Store → AF messaging API template (if consent and not opted out) |
| **Reschedule handler** | Scheduler fire | Store (load) → Follow-up WA template (unbuilt) |
| **Inbound handler** | AF channel webhook → `inbound` | Store (`messages` first) → resume from empty `selection` keys → send |

## WhatsApp × agent (TRIGGERS)

The model does not run on form submit. It runs after the customer’s first inbound.

```
form POST → request-call
          → store write
          → POST /messaging/messages template  (window still closed)
          → wait

inbound   → inbound Edge Function
          → append messages  (before any model call)
          → load lead.selection + last N lines
          → 24h window opens
          → send facts to the WhatsApp Assistant (wording lives on that prompt)
          → POST /messaging/messages text
```

Fetch **before** speech:

1. **Handler preload (sync, no model).** Lead + `selection` + last N messages. This is how the agent already knows name, vehicle, language, consent, mobile.
2. **Tools in the turn.** Catalogue and any other lookup run before the outbound text is sent.
3. **Writes as it goes.** `selection` + the outbound body land in the store in that same turn.

Still deterministic after first inbound: opt-out, `can-send` (closed window → template only), and the reschedule handler. Do not put those on the model.

## Records

### `leads`

One row per phone. Identity **and** the qualification blob.

- `id`
- `mobile_e164` (unique) — **never ask the customer for this**. WhatsApp already gave it.
- `full_name` — stored in full. The model is given the first word only.
- `language` (`ar` \| `en`) — do not flip on Latin/Arabizi inside Arabic
- `gender_form` (`m` \| `f` \| `unknown`) — only a hint. The form and each inbound turn write `m` when the name starts with `عبد`. If it is still unknown, the model may set `m` or `f` from the name. It must not ask. A trailing ه is not feminine.
- `consent_whatsapp`
- `opted_out` — global; blocks every send and every dial
- `opened_by` (`form` \| `reschedule` \| `inbound`)
- `current_channel` (`whatsapp` \| `voice` \| `unset`)
- `current_step` — derived cache of the next empty key (or `channel` / `close`). The model does not advance it.
- `status` (`awaiting_reply` \| `open` \| `scheduled` \| `in_call` \| `hot` \| `cold`)
- `selection` (jsonb) — the only qualification state
- `preferred_call_at`, `outbound_attempts`, `last_inbound_at`, `window_expires_at`
- `updated_at`

### `selection`

Passed to the model every turn as `user_selection`. Null = not asked yet. Filled = never re-ask unless they correct it.

```json
{
  "vehicle": null,
  "payment": null,
  "color": null,
  "order_now": null,
  "accessories": null,
  "timing": null
}
```

| Key | Empty | Filled |
| --- | --- | --- |
| `vehicle` | `null` | catalogue model id (`ALSVIN`, `CS-75-PLUS`, …). Required. |
| `grade` | `null` | catalogue grade name for that vehicle (`Trend`, `Platinum`, …). Required. Asked right after the vehicle. The price in the closing message is that grade’s published price, not a separate question. |
| `payment` | `null` | `cash` \| `finance` \| `lease`. Arabic for lease is تأجير منتهي بالتمليك. Bare تأجير is a rental and is not this value. |
| `color` | `null` | one catalogue color string (not an array — one preference). The customer hears the catalogue list and which one they want, in one message. Do not ask permission to show the colors. |
| `order_now` | `null` | `true` \| `false` \| `"none"`. Yes ≠ HOT. No or `"none"` → COLD, skip accessories. `"none"` means they skipped the question. |
| `accessories` | `null` | array of names, **or** `"none"`. `"none"` is a real answer |
| `purchase` | `null` | `online` \| `telesales` \| `"none"`. Asked after accessories when the order was accepted. Chat is `online` and writes `timing` `now`. A rep call is `telesales`. `"none"` means they skipped it. |
| `rep_time` | `null` | The words they gave for when the rep should call, or `"none"` if they skipped. Asked only after `purchase` is `telesales`. |
| `timing` | `null` | `now` \| `over_month` \| `"none"`. `"none"` means they did not say. `over_month` is cold. |

There is no phone field. Code owns the ask order: vehicle → grade → payment → color → order_now → accessories (only if `order_now=true`, else force `"none"`) → purchase if the order was accepted → rep_time only for a rep call → timing. Vehicle, grade, color, and payment cannot be skipped. The other keys accept `"none"` when they skip the question.

### `submissions`

Append-only form posts. Same person can submit twice; the latest row is the seed (vehicle, name, language, consent).

- `id`, `lead_id`, `full_name`, `mobile_e164`, `vehicle`, `language`, `consent_whatsapp`, `submitted_at`, `source` (`form`)

`request_calls` is leftover from init. New writes go through `ingest_form_submission`.

### `messages` (indexed chat log)

Append-only. Every inbound and outbound turn, including templates, voice transcripts, and tool-side system notes.

- `id`, `lead_id`, `channel` (`whatsapp` \| `voice`), `direction` (`in` \| `out` \| `system`)
- `text`, `lang`, `step` (the `next_ask` at the time), `handler`, `at`
- `meta` — `{ template_name? , call_id? , latency_ms? , kind? }`

**Indexes:** `(lead_id, at)`, `(lead_id, step)`, full-text on `text`.

Retrieval for a turn: last N messages + `selection`. Do not dump the whole log into the model.

## `next_action`

`get_lead_pack` / `record_inbound` return:

| `next_action` | Meaning |
| --- | --- |
| `ask_channel` | First inbound (or channel still `unset`). One question: chat, call now, or schedule. |
| `gather` | Channel chosen. Fill empty `selection` keys. |
| `stop_opted_out` | Do not send, do not dial. |
| `already_closed` | HOT/COLD already written. Don't re-qualify. |

## Write rules

1. A turn writes `leads.selection` (via `patch_selection`) + any new `messages` in the same turn.
2. `"none"` on accessories is coverage. Re-asking a filled key is a defect.
3. Never ask for the mobile. It is `leads.mobile_e164`.
4. Handlers never share code paths that skip the store write.
5. Opt-out is checked before every send and every dial.
6. Do not invent catalogue values to fill a key.
7. When `selection` is complete and the lead is not a scheduled call: one confirmation, then write `leads.status` `hot` (order yes and timing `now`) or `cold` (order no, or `over_month`), then one summary. The summary names the order and that a company rep will get in touch at the time they gave. Do not send a second summary. No emoji on any WhatsApp text.
