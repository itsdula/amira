# TICKET-0003: Voice Assistant cannot hang up by itself

- status: open
- severity: polish
- surface: voice
- filed: 2026-09-17 (agent)

## What I saw

The `POST /assistant` API rejected the inline end-call tool
(`{"type":"endCall","name":"end_call"}` → "expected string id or inline tool
object, got EndCallTool"), so the Voice Assistant shipped with `tools: []`.
Its prompt closes with a clear goodbye and relies on the customer hanging up,
the 30s silence timeout, or the 900s max duration.

## What I expected

The assistant ends the call itself after the closing recap.

## Agent notes

- Root cause: end-call tools apparently must be created/attached via the
  dashboard (or referenced by tool id) rather than inline on create.
- Component: AF dashboard → Voice Assistant → tools; if fixed, restore the
  end_call step wording in the prompt (see `voice-hub/VOICE_ASSISTANT.md`).
- Fix / commit: —
