# AF flows — import, wire, test

Two flows run the product today:

| Flow | File | Trigger |
| --- | --- | --- |
| Send WA Template (init) | `whatsapp-send-template.json` (live in AF already) | Called with `{ name, phone, vehicle, language }` from the form webhook |
| Amira Inbound WhatsApp | `flows/amira-inbound-whatsapp.json` | Catch Webhook — set as the WhatsApp channel `webhookUrl` |

`flows/amira-inbound-whatsapp.json` is generated — edit `flows/build-inbound-flow.mjs` and rerun `node flows/build-inbound-flow.mjs`. Do not hand-edit the JSON.

## Workspace variables (Dashboard → Variables)

| Variable | Value |
| --- | --- |
| `AgenticFlow_API_KEY` | workspace API key (already exists) |
| `SUPABASE_SERVICE_ROLE_KEY` | amira project service-role key. Store writes only. |
| `AMIRA_CHAT_ASSISTANT_ID` | chat-capable assistant with KB **Amira** attached (create it, then paste the id) |

## Wire the inbound flow

1. Import `flows/amira-inbound-whatsapp.json` (or rebuild by hand from the recipe below).
2. Publish, copy the Catch Webhook URL.
3. Messaging → channel **Amira AI - almost human** (`160e6c61-…`) → set `webhookUrl` to that URL.
4. Test without touching WhatsApp: POST a sample at the flow's test URL:

```bash
curl -X POST "<catch-webhook-test-url>" \
  -H "Content-Type: application/json" \
  -d @flows/samples/message-received.text-ar.json
```

Samples: `message-received.text-ar.json` (channel answer "ابغى اكمل واتساب"), `.text-en.json` ("call me now please"), `.button-confirm.json` (template button tap — routes to the channel question), `contact-opted-out.json` (suppression), `form-webhook.ar/.en.json` (what `request-call` POSTs to the init flow — paste into that flow's test panel instead of typing).

Replace `+966500000001` with your own test number for live sends. Sends reach real phones.

## Inbound flow, node by node (rebuild fallback)

Shape: `Catch Webhook → Router(eventType) → [message.received → Code prep_inbound → HTTP record_inbound → Router(next_action)], [contact.opted_out → HTTP PATCH leads], [Otherwise → end]`

**Store HTTP headers** (every Supabase call): `Content-Type: application/json`, `apikey: {{variables['SUPABASE_SERVICE_ROLE_KEY']}}`, `Authorization: Bearer {{variables['SUPABASE_SERVICE_ROLE_KEY']}}`.
**AF HTTP headers** (messaging/chat): `Content-Type: application/json`, `X-Api-Key: {{variables['AgenticFlow_API_KEY']}}`.

1. **prep_inbound** (Code) — inputs `mobile={{trigger…senderIdentifier}}`, `text`, `messageType`, `eventId`, `messageId`, `windowState`. Returns `{ body: { p_mobile, p_text, p_channel: "whatsapp", p_meta } }` with a `[type message]` fallback for empty text. Copy the code from the generated JSON.
2. **store_inbound** (HTTP POST) — `https://tmewbswbhnmuuomdfewq.supabase.co/rest/v1/rpc/record_inbound`, JSON Body `{{prep_inbound['output']['body']}}`. Response body is the lead pack.
3. **route_action** (Router, first match) — on `{{store_inbound['output']['body']['next_action']}}`:
   - `ask_channel` → **parse_channel** (Code): parses 1/2/3, WhatsApp/call/schedule keywords (AR + EN + Arabizi-ish), cancel words. Outputs `mode`, `choice`, `rpcBody`, `sendBody`, `logBody`.
     - Router `mode == set_choice` → **rpc_set_choice** (HTTP POST `…/rpc/set_channel_choice`, body `{{parse_channel['output']['rpcBody']}}`) → **build_confirm** (Code: copy per choice + language; uses `call_window` from the RPC for the outside-hours variant) → **send_confirm** (HTTP POST `https://api.ae.agenticflow.studio/messaging/messages`, body `{{build_confirm['output']['sendBody']}}`) → **log_confirm** (HTTP POST `…/rpc/record_outbound`, body `{{build_confirm['output']['logBody']}}`).
     - Otherwise → **send_question** (messaging send, body `{{parse_channel['output']['sendBody']}}` — the canned channel question or cancel ack) → **log_question** (`record_outbound`, `{{parse_channel['output']['logBody']}}`).
   - `gather` → **chat_generate** (HTTP POST `https://api.ae.agenticflow.studio/chat/message`, body `{ channelId: 160e6c61-…, threadKey: {{trigger…senderIdentifier}}, content: {{trigger…text}}, assistantId: {{variables['AMIRA_CHAT_ASSISTANT_ID']}} }`) → **send_reply** (messaging send, `text.body = {{chat_generate['output']['body']['data']['message']['content']}}`) → **log_reply** (`record_outbound`).
   - Otherwise (`stop_opted_out`, `already_closed`) → end. Nothing is sent.
4. **mark_opted_out** (HTTP PATCH) — `…/rest/v1/leads?mobile_e164=eq.{{trigger…senderIdentifier}}`, header `Prefer: return=minimal`, body `{ "opted_out": true }`.

No `can-send` call on this path: the customer just messaged us, so the 24h window is open by definition. `can-send` is only for sends that are *not* replies (recap after a call, ghost nudges — those are templates anyway).

## Design notes

- The model never runs before `record_inbound` — the inbound text is indexed first, per the store contract.
- `ask_channel` is deterministic. The chat assistant only sees `gather` turns.
- Store round-trips per turn: 1 read+write (`record_inbound`) + 1 log write. `set_channel_choice` adds one more only on the choice turn.
- Known gaps: schedule-a-call captures no time yet (`preferred_call_at` null, open thread "call time pending"); cancel ack doesn't close the lead; dialer doesn't exist, so `call_now` records the choice but no call fires; facts beyond `preferred_channel` are not extracted during gather.
