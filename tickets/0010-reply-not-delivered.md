# TICKET-0010: WhatsApp stays silent after the model replies

- status: fixed
- severity: blocker
- surface: whatsapp
- filed: 2026-09-23 (Dula)
- test number / lead: +966555841684

## What I saw

After the channel webhook pointed at `inbound`, messages such as "مساء الخير" got no WhatsApp reply.

## What I expected

The model reply shows up on the phone.

## Agent notes

- Root cause: the model did reply and `record_outbound` stored it. `POST /messaging/messages` returned 422 `window_closed_no_fallback`. The conversation window was open. `can-send` with `to=+966555841684` reports `not_applicable`; the same number without the leading `+` reports `windowState: open`. AF keys the window on the digits Meta stored.
- Component: `supabase/functions/_shared/af.ts` `sendText`
- Fix / commit: `sendText` now drops the leading `+`. Outbound `meta` records `send_ok` / `send_status`. `inbound` redeployed. Not committed.
