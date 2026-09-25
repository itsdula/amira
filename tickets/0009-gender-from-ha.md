# TICKET-0009: عبدالله addressed as female

- status: fixed
- severity: normal
- surface: whatsapp
- filed: 2026-09-23 (Dula)

## What I saw

The bot used feminine address for the name عبدالله.

## What I expected

Masculine address. A trailing ه is not a gender.

## Agent notes

- Root cause: `guessGender` treated any name ending in ه/ة as female
  before the male-name check. عبدالله ends in ه, so `gender_form` was
  stored as `f` and the prompt then required feminine verbs.
- Component: `_shared/gender.ts` + the per-turn prompt in `brain-turn.ts`.
- Fix: drop the suffix rule and the name lists. `عبد…` is `m`; anything
  else stays `unknown` and the model addresses from the name. inbound v2.
