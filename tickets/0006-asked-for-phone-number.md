# TICKET-0006: Bot asked for a phone number it already has

- status: fixed
- severity: normal
- surface: whatsapp
- filed: 2026-09-21 (Dula, via chat: "The AI asked me for my phone number")
- test number / lead: +966555841684 (`9dcd00a3-7570-4610-a061-5893c0e59f79`)

## What I saw

After agreeing to raise the order and declining accessories, the bot asked
`وش رقم الجوال المناسب للتواصل؟`. The number is already `leads.mobile_e164`.

Same session: accessories were declined (`نكتفي بالطلب`) then the bot asked
for accessories again later — the decline never landed as a fact, so the
GOAL treated the field as uncovered.

## Evidence (`messages` + `brain_audit`, 2026-09-21 12:44–12:46 UTC)

Lead stayed on `current_step = accessories`. `accessories` fact was never written.

1. Customer: `نكتفي بالطلب`
   - rejected: `upsert_fact` `accessories = "none"` → "must be an array of names"
   - rejected: `advance_step` timing → "cannot leave accessories: uncovered facts [accessories]"
   - reply jumped to timing anyway: `متى يناسبك نتواصل معك؟`
2. Customer: `اي وقت`
   - rejected: `upsert_fact timing` → "step accessories may not write timing"
   - reply invented a contact field: `وش رقم الجوال المناسب للتواصل؟`

## What I expected

Never ask for the mobile. Decline of accessories is `"none"` on `selection`.
Then timing (`now` | `over_month`). Close uses `leads.mobile_e164`.

## Agent notes

- Root cause: accessories `"none"` could not be written (facts table required
  an array). The step machine then locked, and the model invented a phone
  question. `step_contexts` was written and never even injected into the prompt.
- Component: store shape. Collapsed to `leads.selection` jsonb. Code owns
  NEXT ASK. Prompt forbids asking for the mobile.
- Fix / commit: `leads.selection` + `patch_selection`; `accessories: "none"`
  is valid; no facts / step_contexts.
