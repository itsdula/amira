# TICKET-0014: تأجير means rental, and a price answer also asked a color

- status: fixed
- severity: normal
- surface: whatsapp
- filed: 2026-09-24 (Dula)
- test number / lead: +966555841684

## What I saw

«تمام يا عبدالله، وش طريقة الشراء اللي تناسبك للهانتر: كاش، تمويل، أو تأجير؟»

Then, after «كيف الاسعار؟»: the prices, and in the same message «لونك وش تفضّل من: رمادي، أسود، أبيض، أو فضي؟»

## What I expected

Lease is تأجير منتهي بالتمليك. تأجير alone is a rental. A price answer is only the price. One question at a time.

## Agent notes

- Root cause: the prompt said “lease” and “one question”, and the model translated lease as تأجير and treated the color ask as that one question on top of the price.
- Component: WhatsApp Assistant prompt, `brain-turn.ts` reply, `brain-contract.ts` payment floor
- Fix: Arabic lease is تأجير منتهي بالتمليك. A customer question is answered on its own; the next field waits. Assistant patched and `inbound` redeployed. Not committed.
