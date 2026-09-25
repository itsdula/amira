# TICKET-0017: confirm booked WhatsApp instead of a call

- status: in-progress
- severity: normal
- surface: whatsapp
- filed: 2026-09-25 (Dula)
- test number / lead: +966555841684 / 094add2d-016e-4a90-8c48-308ba987840e

## What I saw

Form at 05:44 Asia/Riyadh, then تأكيد. Chat continued on WhatsApp. Last line was «تم يا عبدالله، برفعه الآن.» Lead status stayed open.

## What I expected

A callback confirm outside 09:00–21:00 schedules a call time. The lead is not hot.

## Agent notes

- Root cause: the first fix mapped تأكيد to call_now. At 06:11 it sent the 9am call line and set status scheduled before any qualification.
- Component: inbound channel choice (`channel.ts`)
- Fix: تأكيد is WhatsApp again. A call is only booked when they ask for one on the preference step. Deployed inbound 2026-09-25.
