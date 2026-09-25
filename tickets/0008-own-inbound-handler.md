# TICKET-0008: Own inbound + form send (retire AF canvas)

- status: fixed
- severity: normal
- surface: flow
- filed: 2026-09-22 (Dula, via chat: move automation to Edge Functions)

## What I saw

AF automation is a worse logic tree. Templates and inbound routing are
HTTP calls we can make from TypeScript. WhatsApp should hit our function.

## What I expected

AF = assistant + files + KB + REST. Form and inbound are Edge Functions.
Channel `webhookUrl` points at `inbound`. No canvas in the path.

## Agent notes

- Root cause: product decision, not a defect.
- Component: `inbound` Edge Function + `request-call` template send via
  `POST /messaging/messages`. Shared AF client in `_shared/af.ts`.
- Cutover (Dula): set channel webhook to
  `https://tmewbswbhnmuuomdfewq.supabase.co/functions/v1/inbound`,
  then delete the inbound canvas. Secret: `CHANNEL_WEBHOOK_SECRET`.
- Fix / commit: inbound v1, inbound-brain v18, request-call v15.
  2026-09-23: webhook was already pointed at `inbound`, but posts returned
  503 because `CHANNEL_WEBHOOK_SECRET` was unset. Secret is set. inbound v2
  has the looser prompt. Send a new WhatsApp message to confirm.
