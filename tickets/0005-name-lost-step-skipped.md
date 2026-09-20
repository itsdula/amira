# TICKET-0005: Name silently lost; step advanced without its fact (wedged colours)

- status: fixed
- severity: blocker
- surface: whatsapp / store
- filed: 2026-09-20 (Dula, via chat: "asks for my name, then asks for a car model, then uses the car model as my name")
- test number / lead: +966555841684, +966581028684

## What I saw

Bot asked for the name; the customer gave it; the bot moved on to the car
question and then appeared to treat the car model as the name.

## Evidence (brain_audit)

- `+966555841684` 20:15: customer sent "عبدالله" → model emitted
  `upsert_fact {key: customer_name}` (wrong shape — should be `set_name`) →
  validator rejected it (`step vehicle may not write customer_name`) → name
  silently lost; reply moved on. Next turn "CS 75 Plus" produced NO actions
  (vehicle also lost) and the reply "أكيد، CS 75 Plus. ممكن اسمك الكريم؟"
  read as if the car were the name. `full_name` was never actually overwritten.
- `+966581028684` 21:33: customer said "فراري F-40" (not in catalogue) → model
  correctly stored no vehicle **but emitted `advance_step: payment` and the
  executor allowed it** → at colours, every answer failed
  "colours require a known vehicle first" — conversation wedged.

## Agent notes

- Root cause: two contract gaps, one prompt gap.
  1. Executor allowed `advance_step` without the current step's owned facts
     being covered (skipped-vehicle wedge).
  2. `set_name` was validated for length only — a catalogue vehicle name would
     have been accepted as a customer name.
  3. Prompt didn't say names travel ONLY via `set_name` (model invented a
     `customer_name` fact).
- Component: `_shared/brain-contract.ts` (validator), `inbound-brain`
  dynamicContext goals, WhatsApp Assistant contract half, `voice-hub` name set.
- Fix / commit:
  - `advance_step` now requires every `FACTS_OWNED[step]` key covered (stored
    or accepted this same turn; two-pass validation so action order is
    irrelevant).
  - `set_name` / voice-hub `full_name` reject catalogue model/grade names
    (`looksLikeVehicleName`).
  - Goals + assistant contract state: names only via `set_name`; never leave a
    step whose fact is uncovered.
  - Note: the earlier single-goal fix (name-first) already ships; lead
    `+966581028684` (21:31) shows the name path working end-to-end.
