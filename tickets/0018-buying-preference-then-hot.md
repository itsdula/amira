# TICKET-0018: cash close skipped the buying preference

- status: fixed
- severity: normal
- surface: whatsapp
- filed: 2026-09-25 (Dula)
- test number / lead: +966555841684

## What I saw

After accessories the bot asked «وش تفضّلك للخطوة الجاية؟» Brief sequence 9 for cash and buying now is the online-or-telesales choice, then submit hot and send the final WhatsApp message.

## What I expected

Ask fully online or telesales. On the answer, tag hot and send the final message with the callback number already on the lead. Do not ask for a new time.

## Agent notes

- Root cause: the last empty field was `timing`, an open preference, then a confirmation.
- Component: `brain-contract.ts` next ask, `brain-turn.ts` close
- Fix: cash plus an accepted order asks online or telesales, then writes hot and sends the final message with the callback number. Deployed inbound 2026-09-25.
