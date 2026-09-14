---
name: amira-create-wa-template-flow
description: >-
  Generates an AgenticFlow SHARED callable workflow that sends a WhatsApp
  template: Data Gather → Prepare Data (Code) → Make the Call (HTTP). Use when
  creating or importing a WA template send box, Send Form Submission Template,
  callback_request_confirm, or any new template-send subflow. Also use when
  import fails and the user needs copyable node snippets.
---

# amira-create-wa-template-flow

Always produce two things: (1) a full import JSON and (2) three copyable snippets.

**Stop and ask** if any required input is missing. Do not invent template names or languages. Do not assume both `en` and `ar`.

## Ask first (required)

Collect this object. If the user omitted a field, ask — then call the generator. Never fill `templates.*` yourself.

```json
{
  "name": "Send Form Submission Template",
  "languages": ["en", "ar"],
  "templates": {
    "en": "callback_request_confirm_en",
    "ar": "callback_request_confirm_ar"
  },
  "sample": {
    "name": "dula",
    "phone": "+966555841684",
    "vehicle": "Camry",
    "language": "en"
  },
  "params": ["name", "vehicle"],
  "out": "./Send Form Submission Template.json"
}
```

| Field | Ask |
|---|---|
| `languages` | `en` / `en_US` only, `ar` only, or both? English Meta locale is always `en_US` (never `en`). |
| `templates.en` | English Meta template name (only if `en`) |
| `templates.ar` | Arabic Meta template name (only if `ar`) |
| `name` | Flow display name |
| `sample` | Data Gather JSON. Always needs `phone` (E.164). Both-language flows also need `language`. |
| `params` | Which sample keys fill `{{1}}`, `{{2}}`, … |

Schema: [input.schema.json](input.schema.json).

## Deterministic tool

After the object is complete, run only this — do not hand-write the flow JSON:

```bash
node .cursor/skills/amira-create-wa-template-flow/scripts/generate.mjs --config /path/to/input.json
```

Or pipe:

```bash
node .cursor/skills/amira-create-wa-template-flow/scripts/generate.mjs --config - <<'EOF'
{ …the object… }
EOF
```

Exit **2** + `MISSING` on stderr = ask those fields, then rerun. Exit **0** = paste the three snippets from stdout and point at the written file.

Flags (`--name`, `--languages en,ar`, `--template-en`, `--template-ar`, `--sample`, `--params`, `--out`) override `--config` keys. Same validation. No default template names.

## The three nodes (fixed)

| # | Display name | Type | Job |
|---|---|---|---|
| 1 | Data Gather | Callable Flow (`callableFlow`, advanced) | Sample JSON only |
| 2 | Prepare Data | Code (`step_2`) | Adds `apiKey`, returns HTTP fields as **plain objects** |
| 3 | Make the Call | HTTP `send_request` (`step_1`) | Maps `step_2` objects |

Internal names stay **`trigger` → `step_2` → `step_1`**.

Code output keys (always): `url`, `method`, `headers`, `queryParams`, `authType`, `body_type`, `body`, `use_proxy`, `followRedirects`, `response_is_binary`, `failureMode`.

`body` is `{ channelId, to, type, template }` only.

Node 3 JSON Body (dashboard, as an object):

```
{{step_2['output']['body']}}
```

Also map Method / URL / Headers from `step_2`. `apiKey` default is `{{variables['AgenticFlow_API_KEY']}}`.

## Hard rules

- Do not invent a fourth node. No `fetch` / `require` / `axios` in Code.
- Do not stringify JSON for HTTP body. Do not wrap Code `body` in extra `"data"`.
- Do not put Activepieces `{{ }}` inside `template.components` text.
- Do not copy `metadata.externalId` from an old export.
- English on WhatsApp is **`en_US`**, never `en`. `languages` may say `en` or `en_US` — Code always emits `"language": "en_US"`. Arabic stays `"ar"`.
- `languages: ["en"]` or `["en_US"]` → hardcode English name + `en_US`. `["ar"]` → Arabic name + `ar`. Both → `inputs.language === "ar"` switch (form `en` / `en_US` / `ar`).
- One language: do not ask for the other template name.

Channel `160e6c61-174a-4de1-b338-ce2e27666c37`, URL `https://api.ae.agenticflow.studio/messaging/messages`. HTTP `0.11.19`, subflows `0.6.4`.

## Hard lessons

- Code sandbox has no `fetch` / `require`. HTTP piece sends.
- No `templateVariables` keys `"1"` / `"2"`. Fill `components.parameters[].text` in Code.
- Bare `{{ name }}` in an HTTP body becomes empty → WhatsApp `#131008`.
- `sent` + `wamid` is not delivered. Marketing → `#131049`.
