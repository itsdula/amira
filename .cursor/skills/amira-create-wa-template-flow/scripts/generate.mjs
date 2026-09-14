#!/usr/bin/env node
/**
 * Deterministic WA-template flow generator.
 * Input: one JSON object (--config file, stdin, or flags).
 * Output: import JSON file + three snippets.
 * Missing required fields → exit 2 and print MISSING (do not invent names).
 *
 *   node generate.mjs --config input.json
 *   node generate.mjs --config - < input.json
 *   node generate.mjs --name "…" --languages en,ar --template-en … --template-ar … \
 *     --sample '{…}' --params name,vehicle --out ./flow.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CHANNEL_ID = "160e6c61-174a-4de1-b338-ce2e27666c37";
const SEND_URL = "https://api.ae.agenticflow.studio/messaging/messages";
const API_KEY_REF = "{{variables['AgenticFlow_API_KEY']}}";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || process.argv[i + 1] == null) return undefined;
  return process.argv[i + 1];
}

function triggerRef(key) {
  return `{{trigger['output']['data']['${key}']}}`;
}

function jsString(value) {
  return JSON.stringify(value);
}

function readConfig() {
  const path = arg("--config");
  let file = {};
  if (path === "-") {
    file = JSON.parse(readFileSync(0, "utf8"));
  } else if (path) {
    file = JSON.parse(readFileSync(resolve(path), "utf8"));
  }

  const flags = {};
  if (arg("--name")) flags.name = arg("--name");
  if (arg("--out")) flags.out = arg("--out");
  if (arg("--languages")) {
    flags.languages = arg("--languages")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (arg("--template-en") || arg("--template-ar")) {
    flags.templates = { ...(file.templates ?? {}) };
    if (arg("--template-en")) flags.templates.en = arg("--template-en");
    if (arg("--template-ar")) flags.templates.ar = arg("--template-ar");
  }
  if (arg("--sample")) flags.sample = JSON.parse(arg("--sample"));
  if (arg("--params")) {
    flags.params = arg("--params")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return normalizeInput({ ...file, ...flags });
}

/** Form/sample may say "en"; Meta template.language must be "en_US". */
function asLang(value) {
  if (value === "en" || value === "en_US") return "en";
  if (value === "ar") return "ar";
  return value;
}

function normalizeInput(input) {
  const languages = Array.isArray(input.languages)
    ? [...new Set(input.languages.map(asLang))]
    : input.languages;
  const raw = input.templates && typeof input.templates === "object" ? input.templates : {};
  const templates = { ...raw };
  if (templates.en_US && !templates.en) templates.en = templates.en_US;
  delete templates.en_US;
  return { ...input, languages, templates };
}

function missingList(input) {
  const missing = [];
  if (!input.name || String(input.name).trim() === "") {
    missing.push({ field: "name", ask: "Flow display name" });
  }

  const langs = Array.isArray(input.languages) ? input.languages : [];
  const okLangs = langs.every((l) => l === "en" || l === "ar");
  if (!langs.length || !okLangs) {
    missing.push({
      field: "languages",
      ask: "Which languages: en only, ar only, or both?",
    });
  } else {
    const templates = input.templates && typeof input.templates === "object" ? input.templates : {};
    if (langs.includes("en") && !templates.en) {
      missing.push({ field: "templates.en", ask: "English Meta template name" });
    }
    if (langs.includes("ar") && !templates.ar) {
      missing.push({ field: "templates.ar", ask: "Arabic Meta template name" });
    }
  }

  const sample = input.sample && typeof input.sample === "object" ? input.sample : null;
  if (!sample) {
    missing.push({ field: "sample", ask: "Data Gather sample JSON (must include phone)" });
  } else if (!sample.phone) {
    missing.push({ field: "sample.phone", ask: "E.164 phone, e.g. +966555841684" });
  } else if (!/^\+[1-9][0-9]{7,14}$/.test(String(sample.phone))) {
    missing.push({ field: "sample.phone", ask: "phone must be E.164 (+ and 8–15 digits)" });
  }

  if (langs.includes("en") && langs.includes("ar") && sample && !sample.language) {
    missing.push({
      field: "sample.language",
      ask: "Both languages: sample needs language (en / en_US or ar). Meta English is always en_US.",
    });
  }

  const params = Array.isArray(input.params) ? input.params : [];
  if (!params.length) {
    missing.push({
      field: "params",
      ask: "Body placeholder keys in order, e.g. name,vehicle",
    });
  } else if (sample) {
    for (const key of params) {
      if (!(key in sample)) {
        missing.push({
          field: `sample.${key}`,
          ask: `params includes "${key}" but sample has no such key`,
        });
      }
    }
  }

  return missing;
}

function buildCode({ languages, templates, params }) {
  const both = languages.includes("en") && languages.includes("ar");
  const arOnly = languages.length === 1 && languages[0] === "ar";
  const paramLines = params
    .map((key) => `              { type: "text", text: String(inputs.${key} ?? "") },`)
    .join("\n");

  let nameExpr;
  let langExpr;
  if (both) {
    nameExpr = `ar\n          ? ${jsString(templates.ar)}\n          : ${jsString(templates.en)}`;
    langExpr = `ar ? "ar" : "en_US"`;
  } else if (arOnly) {
    nameExpr = jsString(templates.ar);
    langExpr = `"ar"`;
  } else {
    nameExpr = jsString(templates.en);
    langExpr = `"en_US"`;
  }

  const arLine = both ? `  const ar = inputs.language === "ar";\n` : "";

  return `export const code = async (inputs) => {
${arLine}  return {
    url: ${jsString(SEND_URL)},
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": inputs.apiKey,
    },
    queryParams: {},
    authType: "NONE",
    body_type: "json",
    body: {
      channelId: ${jsString(CHANNEL_ID)},
      to: inputs.phone,
      type: "template",
      template: {
        name: ${nameExpr},
        language: ${langExpr},
        components: [
          {
            type: "body",
            parameters: [
${paramLines}
            ],
          },
        ],
      },
    },
    use_proxy: false,
    followRedirects: false,
    response_is_binary: false,
    failureMode: "continue_none",
  };
};`;
}

function buildFlow({ name, sample, languages, templates, params }) {
  const code = buildCode({ languages, templates, params });
  const input = { apiKey: API_KEY_REF };
  for (const key of Object.keys(sample)) {
    input[key] = triggerRef(key);
  }

  return {
    name,
    type: "SHARED",
    summary: "",
    description: "",
    tags: ["whatsapp", "template"],
    blogUrl: "",
    metadata: {},
    author: "amira",
    categories: [],
    pieces: ["@activepieces/piece-subflows", "@activepieces/piece-http"],
    flows: [
      {
        displayName: name,
        trigger: {
          name: "trigger",
          valid: true,
          displayName: "Data Gather",
          type: "PIECE_TRIGGER",
          nextAction: {
            name: "step_2",
            skip: false,
            type: "CODE",
            valid: true,
            displayName: "Prepare Data",
            settings: {
              input,
              sampleData: {},
              sourceCode: { code, packageJson: "{}" },
              errorHandlingOptions: {
                retryOnFailure: { value: false },
                continueOnFailure: { value: false },
              },
            },
            nextAction: {
              name: "step_1",
              skip: false,
              type: "PIECE",
              valid: true,
              displayName: "Make the Call",
              settings: {
                pieceName: "@activepieces/piece-http",
                actionName: "send_request",
                pieceVersion: "0.11.19",
                sampleData: {},
                input: {
                  url: "{{step_2['output']['url']}}",
                  body: { data: "{{step_2['output']['body']}}" },
                  method: "{{step_2['output']['method']}}",
                  headers: "{{step_2['output']['headers']}}",
                  authType: "NONE",
                  body_type: "json",
                  use_proxy: false,
                  authFields: {},
                  failureMode: "continue_all",
                  queryParams: {},
                  proxy_settings: {},
                  followRedirects: false,
                  response_is_binary: false,
                },
                propertySettings: {
                  url: { type: "MANUAL" },
                  body: {
                    type: "MANUAL",
                    schema: {
                      data: {
                        type: "JSON",
                        required: true,
                        displayName: "JSON Body",
                      },
                    },
                  },
                  method: { type: "DYNAMIC" },
                  headers: { type: "DYNAMIC" },
                  timeout: { type: "MANUAL" },
                  authType: { type: "MANUAL" },
                  body_type: { type: "MANUAL" },
                  use_proxy: { type: "MANUAL" },
                  authFields: { type: "MANUAL", schema: {} },
                  failureMode: { type: "MANUAL" },
                  queryParams: { type: "MANUAL" },
                  proxy_settings: { type: "MANUAL", schema: {} },
                  followRedirects: { type: "MANUAL" },
                  response_is_binary: { type: "MANUAL" },
                },
                errorHandlingOptions: {
                  retryOnFailure: { value: false },
                  continueOnFailure: { value: false },
                },
              },
            },
          },
          settings: {
            sampleData: {},
            propertySettings: {
              mode: { type: "MANUAL" },
              sampleData: { type: "MANUAL" },
              exampleData: {
                type: "MANUAL",
                schema: {
                  sampleData: {
                    type: "JSON",
                    required: true,
                    displayName: "Sample Data",
                  },
                },
              },
            },
            pieceName: "@activepieces/piece-subflows",
            pieceVersion: "0.6.4",
            triggerName: "callableFlow",
            input: {
              mode: "advanced",
              exampleData: { sampleData: sample },
            },
          },
        },
        valid: true,
        schemaVersion: "22",
        notes: [],
      },
    ],
    status: "PUBLISHED",
  };
}

function printMissing(missing) {
  const lines = ["MISSING — ask the user; do not invent template names or languages.", ""];
  for (const row of missing) {
    lines.push(`- ${row.field}: ${row.ask}`);
  }
  lines.push("");
  lines.push("Required object (see input.schema.json):");
  lines.push(`{
  "name": "Send Form Submission Template",
  "languages": ["en", "ar"],
  "templates": { "en": "callback_request_confirm_en", "ar": "callback_request_confirm_ar" },
  "sample": { "name": "dula", "phone": "+966555841684", "vehicle": "Camry", "language": "en" },
  "params": ["name", "vehicle"],
  "out": "./Send Form Submission Template.json"
}`);
  process.stderr.write(`${lines.join("\n")}\n`);
}

let input;
try {
  input = readConfig();
} catch (err) {
  process.stderr.write(`Invalid JSON: ${err.message}\n`);
  process.exit(1);
}

const missing = missingList(input);
if (missing.length) {
  printMissing(missing);
  process.exit(2);
}

const flow = buildFlow(input);
const dest = resolve(
  input.out || `${String(input.name).replace(/\s+/g, "-")}.json`,
);
writeFileSync(dest, `${JSON.stringify(flow, null, 2)}\n`);

const code = flow.flows[0].trigger.nextAction.settings.sourceCode.code;
process.stdout.write(`Wrote ${dest}

## Node 1 — Data Gather sample
${JSON.stringify(input.sample, null, 2)}

## Node 2 — Prepare Data
Inputs: ${Object.keys(input.sample).join(", ")}, apiKey=${API_KEY_REF}

${code}

## Node 3 — Make the Call JSON Body
{{step_2['output']['body']}}
`);
