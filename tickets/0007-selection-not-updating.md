# TICKET-0007: Gather turns never write selection

- status: fixed
- severity: blocker
- surface: whatsapp
- filed: 2026-09-22 (Dula, via chat: "it is not updating my selections")
- test number / lead: +966555841684 (`fc5b093d-58c8-4eb4-9396-ccfdd5dd8ba7`)

## What I saw

After a `reset_test_data` run, the WhatsApp chat walked the whole path
(UNI S → كاش → asked for colors → ازرق → raise the order → no accessories
→ بكرة العصر) but `leads.selection` stayed all-null and `current_step`
stayed `vehicle`. The last bot line asked for the car again.

## What I expected

Each answered key lands on `leads.selection` in that turn. NEXT ASK moves
on. A filled key is never re-asked.

## Agent notes

- Evidence (`messages` 2026-09-22 00:55–00:59 UTC): every gather
  `brain_audit` is `applied []` / `rejected []` / `fallback false`. The
  model returned valid JSON with an empty `actions` array. `set_name`
  wrote once; channel went through the keyword fast path. AF thread
  memory carried the chat; the store did not.
- Second defect on the same run: with `vehicle` still null, the model
  listed the register-anchor colors (ابيض / رمادي / أحمر / أزرق). UNI-S
  colors in the catalogue are ابيض, اسمنتي, أسود, ذهبي, رمادي داكن —
  أزرق is not one of them, so it must not be persisted.
- Root cause: writes depended on the model emitting `patch_selection`.
  The live assistant prompt already has that contract; the model still
  omitted the action. "actions may be empty" read as permission to skip.
- Component: inbound-brain executor (`brain-contract` floor) + assistant
  contract wording. Code writes a clear answer to NEXT ASK from the
  inbound text when it maps to a catalogue/enum value.
- Fix / commit: inbound-brain v17. Code floor `floorPatchFromText` writes
  NEXT ASK from a clear inbound answer. AF WhatsApp Assistant prompt
  patched 2026-09-22 (must emit patch_selection; colors only from
  [CONTEXT]). Lead recovered to `vehicle=UNI-S`, `payment=cash`,
  `next_ask=color`. أزرق was not written (not a UNI-S color).
