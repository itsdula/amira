# TICKET-0011: close loops and the lead stays open

- status: fixed
- severity: blocker
- surface: whatsapp
- filed: 2026-09-23 (Dula)
- test number / lead: +966555841684

## What I saw

The test sounded like a buyer. The chat then repeated a summary and a confirmation. The opening used a flower emoji. The timing question was “now or within a month”.

## What I expected

Ask an open preference. A call request schedules a call. Otherwise one confirmation, tag HOT, then one summary: the order, and that a company rep will get in touch at the time they gave. No emoji.

## Agent notes

- Root cause: selection was complete (`EADO-PLUS`, cash, color, order yes, accessories none, timing now) and `leads.status` stayed `open`. Nothing writes hot/cold, so every later turn was another gather and the model kept summarizing. The emoji and the binary timing question came from the assistant.
- Component: `brain-turn.ts` close, WhatsApp Assistant prompt
- Fix / commit: close is one confirmation, then `leads.status`, then one summary. Preference question replaces the binary timing ask. Emoji is stripped on send. `inbound` redeployed. Not committed.
