# TICKET-0004: Ghost + closing templates not submitted to Meta

- status: open
- severity: normal
- surface: whatsapp
- filed: 2026-09-17 (agent)

## What I saw

Only `callback_request_confirm` (en_US / ar) exists. The ghost service
(re-engage silent leads) and the close service (recap after qualification)
both need UTILITY templates for out-of-window sends, and Meta review time is
days — this blocks those services regardless of code.

## What I expected

Two approved UTILITY templates: a follow-up nudge and a closing recap
(en_US + ar each). Copy must stay utility-toned — Meta recategorized the
earlier sales-y copy to MARKETING and then hard-blocked it (`#131049`);
see AGENT-HANDOFF "WhatsApp templates".

## Agent notes

- Root cause: templates were deliberately deferred; review latency now on the
  critical path for ghost/close.
- Component: Meta template submission (dashboard — API keys can't manage
  templates) + then the ghost/close services consume them.
- Fix / commit: —
