# TICKET-0015: still says تأجير, and gender stays unknown

- status: fixed
- severity: normal
- surface: whatsapp
- filed: 2026-09-25 (Dula)
- test number / lead: +966555841684

## What I saw

«كاش، تمويل، أو تأجير؟» after the lease wording was already fixed. After the form and the chat, `gender_form` was still `unknown` for عبدالله الشهيل.

## What I expected

تأجير منتهي بالتمليك. Gender filled when the name tells it, including by the model when the code cannot tell.

## Agent notes

- Root cause: the model ignored the prompt and said تأجير. The form never wrote `gender_form`, and there was no action for the model to set it.
- Component: reply rewrite in `inbound` / `brain-turn`, form `request-call`, `set_gender`
- Fix: outbound text rewrites bare تأجير to تأجير منتهي بالتمليك. The form and each turn write m for a عبد name. If gender is still unknown, the model can set m or f and must not ask. This lead is now m. `inbound` and `request-call` redeployed. Not committed.
