# TICKET-0013: reply uses the full name

- status: fixed
- severity: normal
- surface: whatsapp
- filed: 2026-09-23 (Dula)
- test number / lead: +966555841684

## What I saw

After the form, Amira wrote: «هلا عبدالله الهشيل تبي الدفع كاش ولا تمويل؟»

## What I expected

عبدالله only.

## Agent notes

- Root cause: `leads.full_name` is عبدالله الهشيل. `dynamicContext` passed that whole string as `name`, and the assistant used it.
- Component: `brain-turn.ts` facts, WhatsApp Assistant prompt
- Fix: the name fact is the first word. Prompt says never add a family name. Assistant patched and `inbound` redeployed. Not committed.
