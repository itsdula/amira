# TICKET-0019: buying-now was assumed

- status: wont-fix
- severity: normal
- surface: whatsapp
- filed: 2026-09-25 (Dula)
- test number / lead: +966555841684

## What I saw

The chat never asked whether he wants the car now or in a month or more. Choosing telesales stored timing as now.

## What I expected

After accessories, ask that question. A month or more is cold. Buying now continues to the purchase choice for cash.

## Agent notes

- Root cause: cash close wrote `timing` `now` with the purchase answer, and the timing question came after that, or was skipped.
- Component: `brain-contract.ts` next ask
- Fix: reverted. The now-or-a-month question sounded robotic. Cash close again asks online or telesales and writes timing now.
