# Tickets — how concerns get to the next agent

One markdown file per concern, in this folder. Dula writes what he saw in
plain words; the agent triages it with the routing map below, works it, and
updates the ticket as it moves. Tickets are the queue — agents check here
first (enforced by `.cursor/rules/tickets.mdc`).

## Filing (Dula)

1. Copy `TEMPLATE.md` to `NNNN-short-slug.md` (next free number).
2. Fill what you know — a WhatsApp screenshot description, the phrase that went
   wrong, the test number you used, roughly when. Don't guess the component;
   the routing map is the agent's job.
3. Commit it (or just leave the file — the agent will commit it with the fix).

## Triaging (agent)

1. Read the ticket. Find the turn in the store first — evidence beats guessing:
   ```sql
   select at, direction, channel, text, meta from messages
   where lead_id = (select id from leads where mobile_e164 = '+9665…')
   order by at;
   ```
   `meta.kind = 'brain_audit'` rows show what the model proposed, what the
   executor accepted/rejected, which provider ran, and latency.
   `meta.kind = 'voice_call_report'` / `'voice_audit'` rows are the call trail.
2. Route with the map below. Fix at the owning component, not the symptom.
3. Update the ticket: status, findings (one paragraph), what changed, commit hash.

Statuses: `open` → `in-progress` → `fixed` (or `wont-fix` / `blocked (needs Dula)`).

## Routing map — symptom → where it lies

| Symptom | Look at | Notes |
| --- | --- | --- |
| Wording is rude / wrong dialect / bad formatting on WhatsApp | AF dashboard → **WhatsApp Assistant** system message (tune half) | Register anchors are the strongest lever. Never touch below the contract line. |
| Voice call sounds wrong (tone, procedure, language) | AF dashboard → **Voice Assistant** system message; voice card choice | Voice card must be an Arabic one for Najdi output. |
| Asked two questions in one message / skipped the name | `inbound-brain` `dynamicContext` GOAL logic (`supabase/functions/inbound-brain/index.ts`) | The goal per turn is code-owned, not prompt-owned. |
| Re-asked a field the customer already gave or declined | `brain_audit` row first: was `patch_selection` rejected? Then `_shared/brain-contract.ts` vs `[CONTEXT]` `user_selection` | A filled key re-asked is a defect by spec. Never ask for the mobile. |
| Invented a price / wrong price / unknown colour offered | `_shared/catalogue.ts` staleness (rerun scrape + `emit-module.mjs`) or assistant ignoring the contract | Prices only ever come from the catalogue slice. |
| No reply at all on WhatsApp | Channel `webhookUrl`, then `inbound` logs, HMAC, then outbound `meta.send_ok` | A stored reply with `send_status` 422 means AF refused delivery. Free-form `to` is the mobile without a leading `+`. |
| Reply arrives but state didn't change (no facts, step stuck) | `brain_audit` `rejected[]` reasons; RPC errors in function logs | Executor rejections are intentional — read the reason before "fixing". |
| "We'll call you now" but no call | Which path recorded the choice? Fast path: flow `route_dial`/`place_call` nodes. Brain path: `brain_audit` `applied[]` — look for `dial:queued` / `dial:failed (…)` / `dial:skipped` | `dial:skipped` = `VOICE_ASSISTANT_ID` secret missing. Out of hours is correct behaviour (scheduled, ghost service dials later — not built). |
| Call happened but nothing landed in the store | `voice-hub` function logs; `VOICE_HUB_SECRET` mismatch (401s); `voice_audit` rejected list | Extraction enum drift (payment/timing wording) rejects facts by design. |
| Form submitted but no template arrived | `request-call` function logs → `FORM_WEBHOOK_URL` → AF init flow runs → Meta template status | Marketing-category rejections: see AGENT-HANDOFF WhatsApp templates section. |
| Constraint violation / SQL error in a run | `supabase/migrations/` — check the RPC the failing node calls | Mobile format issues should be dead (`normalize_mobile`), suspect new fields. |
| Customer opted out but still got messages | `leads.opted_out`, flow `mark_opted_out` branch, brain opt-out action | Opt-out must stick everywhere; treat as highest severity. |
| Import fails / flow edits lost | `flows/build-inbound-flow.mjs` + `flows/RECIPES.md` import rules | Never hand-edit the JSON; regenerate and re-import. |

## Open tickets

The files in this folder are the live list — `grep -l "status: open" tickets/`.
