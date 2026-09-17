# TICKET-0002: Voice end-to-end blocked on two secrets + one flow re-import

- status: blocked (needs Dula)
- severity: blocker
- surface: voice / flow
- filed: 2026-09-17 (agent)

## What I saw

The dial-and-report loop is deployed but dormant until:

1. Supabase Edge Function secrets are set (dashboard → Edge Functions → Secrets):
   - `VOICE_ASSISTANT_ID=bb7401d6-b4ba-45e1-98b2-948a74448ed5`
   - `VOICE_HUB_SECRET=<the value printed at assistant creation — also stored
     on the assistant's server.secret; ask the previous agent transcript or
     re-mint by PATCHing the assistant server block and setting both sides>`
2. `flows/amira-inbound-whatsapp.json` is re-imported (it gained
   `route_dial` → `place_call` so the keyword fast path dials), trigger swapped
   to Catch Webhook, channel `webhookUrl` re-pointed. Steps: `flows/RECIPES.md`.

Until (1), the brain logs `dial:skipped (no VOICE_ASSISTANT_ID)` and voice-hub
401s every report. Until (2), only the semantic brain path dials.

## What I expected

WhatsApp "اتصلوا علي الحين" (inside 09:00–21:00 Riyadh) → phone rings →
after the call, transcript + extracted facts appear in `messages`/`facts`.

## Agent notes

- Root cause: secrets are owner-only; flow import is dashboard-only.
- Component: Supabase secrets + AF flow import.
- Fix / commit: repo side shipped (brain v13, voice-hub v1, flow regenerated).
