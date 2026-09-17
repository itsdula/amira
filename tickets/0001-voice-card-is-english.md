# TICKET-0001: Voice Assistant speaks with an English voice card

- status: blocked (needs Dula)
- severity: blocker
- surface: voice
- filed: 2026-09-17 (agent, on creation of the voice slice)

## What I saw

The Voice Assistant (`bb7401d6-b4ba-45e1-98b2-948a74448ed5`) was created with
voice card `holly` — an English voice — because tier voice cards are not
listable via the API and holly was the only verified-working premium card.
Najdi Arabic text through an English TTS card will sound wrong on real calls.

## What I expected

An Arabic (ideally Gulf/Najdi-flavoured) voice card.

## Agent notes

- Root cause: AF API exposes no voice-card list; card choice is dashboard-only.
- Component: AF dashboard → Voice Assistant → voice card (a tuning-surface
  setting, no code involved).
- Fix / commit: **Dula action** — dashboard → Assistants → Voice Assistant →
  pick an Arabic voice card → save. Then close this ticket.
