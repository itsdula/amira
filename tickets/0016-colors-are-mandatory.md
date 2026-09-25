# TICKET-0016: asked permission to show colors

- status: fixed
- severity: polish
- surface: whatsapp
- filed: 2026-09-25 (Dula)
- test number / lead: +966555841684

## What I saw

After cash: «تم يا عبدالله، كاش. تبي أقولك على الألوان المتوفرة للإيدو بلس؟»

The later list was right, except it opened with أكيد.

## What I expected

Colors are required. List them and ask which one in the same message, opening with تمام.

## Agent notes

- Root cause: the color step was left to the model, which asked permission first.
- Component: `brain-turn.ts` color reply, WhatsApp Assistant prompt
- Fix: inbound now sends the colour list and the ask in one message when colour is the empty field. Deployed 2026-09-25.
