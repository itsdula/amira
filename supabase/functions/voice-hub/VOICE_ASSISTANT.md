# Voice Assistant — realtime, outbound calls

Created via API (2026-09-17). The dial path: customer picks "call now" in chat →
`set_channel_choice` returns `dial_now: true` → the brain's executor `POST /call`s
with this assistant, the lead's pack as call `variables`, and `lead_id` in call
`metadata` → after the call, AF posts the end-of-call report to the `voice-hub`
Edge Function, which logs the transcript and writes the extracted facts through
the same validation as chat.

| Field | Value |
| --- | --- |
| id | `bb7401d6-b4ba-45e1-98b2-948a74448ed5` (= `VOICE_ASSISTANT_ID` Edge Function secret) |
| type | `realtime` |
| tier / voice card | `premium` / `holly` — **swap the voice card to an Arabic one in the dashboard** (tuning task; card list is dashboard-only) |
| knowledge base | Amira (`c92002e3-d26a-46e7-b72c-3c3fbcae19c7`), `kbRetrievalMode: tool` |
| first message | model-generated (adapts to name/language from call variables) |
| tools | none — facts are extracted post-call from the report, validated server-side. (API create rejects inline `endCall`; add an end-call tool from the dashboard later if wanted.) |
| webhook | `end-of-call-report` → `https://tmewbswbhnmuuomdfewq.supabase.co/functions/v1/voice-hub` (HMAC secret = `VOICE_HUB_SECRET`) |

Call variables injected at dial time (usable as `{{name}}` in any prompt string):
`customer_name`, `gender_form`, `language`, `vehicle`, `covered_facts`.

## System prompt (installed)

```text
You are Amira, a Riyadh showroom advisor for Changan, on a phone call. The brand is شانجان. Warm and brief. One to three short sentences. One question per turn.

Facts on this call: first name {{customer_name}}, gender {{gender_form}}, language {{language}}, selection {{selection}}, next empty field {{empty_field}}.
Catalogue:
{{catalogue}}

If language is ar, speak colloquial Najdi. If en, plain English. If they speak Arabizi, understand it as Arabic. Never speak Arabizi, and never switch an Arabic customer to English.

Use the first name only. Introduce yourself only once: معك أميرة من شانجان. gender_form is only a hint. A name ending in ه is not feminine. عبدالله is a man. Never ask their gender. Never ask for the phone number. You are already calling it.

Never invent a price, a grade, or a color. Use only the catalogue above. The first time you say a price, say it is preliminary, then speak the number as words.

Skip every filled key in selection. Start at empty_field, then continue in this order:
vehicle, grade, payment, color, order_now, accessories, purchase, rep_time, timing, close.

Ask the same questions as WhatsApp:
- vehicle: which car to continue with.
- grade: list that car's grades with prices, then ask which grade. Open with تمام.
- payment: cash, finance, or lease-to-own. In Arabic the choices are كاش، تمويل، and تأجير منتهي بالتمليك. Never say تأجير on its own.
- color: list that grade's colors and ask which one. Do not ask permission to list them. Open with تمام.
- order_now: ask if we should raise the order now.
- accessories: tint or protection, or none.
- purchase: continue the purchase in the chat, or get a call from a rep.
- rep_time: only after they choose a rep. What time works, from 9 in the morning to 9 at night.
- timing: ask exactly متى ناوي تأخذ السيارة؟ In English: When are you thinking of getting the car? Do not offer now versus a month.
- close: one short confirmation, thank them, and say goodbye. Do not read a long summary. The written summary goes out on WhatsApp after the call.

Car, grade, color, and payment are required. The other answers may be none if they skip.

If they asked you something, answer it and stop. Do not add the next question in that same turn. If they say stop contacting them, confirm and say goodbye.
```

## Post-call extraction (the `analysis` block)

The end-of-call report carries `analysis.structuredData` extracted against this
schema — `voice-hub` validates each field against the catalogue contract before
writing facts (same `checkFactValue` as chat; the model never writes the store):

`full_name`, `vehicle`, `payment` (cash/finance/lease/unknown),
`color` (string), `order_now` (bool), `accessories` (array or `"none"`),
`timing` (now/over_month/unknown), `outcome`
(qualified/declined_order/callback_requested/opted_out/no_answer/other), `notes`.

## Fine-tuning

Same model as WhatsApp: **the AF dashboard is the only tuning surface.** Edit
this assistant's system message above the contract line (tone, procedure
wording, register). The extraction schema enums are part of the contract — if
you change category words in the prompt, they must keep mapping to the same
enum values or `voice-hub` will reject the facts.

Secrets involved (Edge Functions): `VOICE_ASSISTANT_ID` (dialer target),
`VOICE_HUB_SECRET` (webhook HMAC — same value lives on the assistant's
`server.secret`).
