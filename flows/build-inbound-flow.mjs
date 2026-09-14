#!/usr/bin/env node
// Deterministic builder for the Amira inbound WhatsApp flow.
// Emits flows/amira-inbound-whatsapp.json (AgenticFlow import, schema 22).
// Rebuild after edits:  node flows/build-inbound-flow.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SUPABASE_URL = "https://tmewbswbhnmuuomdfewq.supabase.co";
const AF_URL = "https://api.ae.agenticflow.studio";
const CHANNEL_ID = "160e6c61-174a-4de1-b338-ce2e27666c37";
// Match the versions that demonstrably import/export in THIS workspace
// (whatsapp-messaging.json, whatsapp-send-template.json). 0.11.19 was rejected.
const HTTP_VERSION = "0.11.10";
const WEBHOOK_VERSION = "0.1.36";

const SERVICE_KEY_VAR = "{{variables['SUPABASE_SERVICE_ROLE_KEY']}}";
const AF_KEY_VAR = "{{variables['AgenticFlow_API_KEY']}}";
const ASSISTANT_VAR = "{{variables['AMIRA_CHAT_ASSISTANT_ID']}}";

const VEHICLE_NAMES = {
  "ALSVIN": "ALSVIN",
  "CS-35-PLUS": "CS 35 Plus",
  "CS-75-PLUS": "CS 75 Plus",
  "CS-95": "CS 95",
  "EADO-PLUS": "EADO Plus",
  "HUNTER-PLUS": "Hunter",
  "UNI-K": "UNI-K",
  "UNI-S": "UNI S",
  "UNI-T": "UNI-T",
  "UNI-V": "UNI V",
};

// ---------------------------------------------------------------- helpers

const MANUAL = (keys) =>
  Object.fromEntries(keys.map((k) => [k, { type: "MANUAL" }]));

const errorDefaults = {
  retryOnFailure: { value: false },
  continueOnFailure: { value: false },
};

function httpNode(name, displayName, { url, method = "POST", headers, bodyData }, nextAction = null) {
  const node = {
    name,
    skip: false,
    type: "PIECE",
    valid: true,
    displayName,
    settings: {
      pieceName: "@activepieces/piece-http",
      actionName: "send_request",
      pieceVersion: HTTP_VERSION,
      sampleData: {},
      input: {
        url,
        method,
        headers,
        authType: "NONE",
        body_type: "json",
        body: { data: bodyData },
        use_proxy: false,
        followRedirects: false,
        response_is_binary: false,
        failureMode: "continue_none",
        authFields: {},
        queryParams: {},
        proxy_settings: {},
      },
      propertySettings: {
        ...MANUAL([
          "url", "method", "headers", "timeout", "authType", "body_type",
          "use_proxy", "followRedirects", "response_is_binary", "failureMode",
        ]),
        body: {
          type: "MANUAL",
          schema: { data: { type: "JSON", required: true, displayName: "JSON Body" } },
        },
        authFields: { type: "MANUAL", schema: {} },
        queryParams: { type: "MANUAL" },
        proxy_settings: { type: "MANUAL", schema: {} },
      },
      errorHandlingOptions: errorDefaults,
    },
  };
  if (nextAction) node.nextAction = nextAction;
  return node;
}

function codeNode(name, displayName, input, code, nextAction = null) {
  const node = {
    name,
    skip: false,
    type: "CODE",
    valid: true,
    displayName,
    settings: {
      input,
      sourceCode: { packageJson: "{}", code },
      errorHandlingOptions: errorDefaults,
    },
  };
  if (nextAction) node.nextAction = nextAction;
  return node;
}

function router(name, displayName, branches, children, nextAction = null) {
  const node = {
    name,
    skip: false,
    type: "ROUTER",
    valid: true,
    displayName,
    children,
    settings: { branches, sampleData: {}, executionType: "EXECUTE_FIRST_MATCH" },
  };
  if (nextAction) node.nextAction = nextAction;
  return node;
}

const textMatch = (branchName, firstValue, secondValue) => ({
  branchName,
  branchType: "CONDITION",
  conditions: [[{ operator: "TEXT_EXACTLY_MATCHES", firstValue, secondValue, caseSensitive: false }]],
});

const fallback = { branchName: "Otherwise", branchType: "FALLBACK" };

const storeHeaders = {
  "Content-Type": "application/json",
  apikey: SERVICE_KEY_VAR,
  Authorization: `Bearer ${SERVICE_KEY_VAR}`,
};

const afHeaders = {
  "Content-Type": "application/json",
  "X-Api-Key": AF_KEY_VAR,
};

// ---------------------------------------------------------------- code steps

const prepInboundCode = `export const code = async (inputs) => {
  const mt = String(inputs.messageType ?? "text");
  let text = String(inputs.text ?? "").trim();
  if (!text) text = "[" + mt + " message]";
  return {
    body: {
      p_mobile: String(inputs.mobile ?? ""),
      p_text: text,
      p_channel: "whatsapp",
      p_meta: {
        event_id: inputs.eventId ?? null,
        message_id: inputs.messageId ?? null,
        message_type: mt,
        window_state: inputs.windowState ?? null,
      },
    },
  };
};
`;

const parseChannelCode = `export const code = async (inputs) => {
  const pack = inputs.pack || {};
  const lead = pack.lead || {};
  const latest = pack.latest_submission || {};
  const ar = lead.language === "ar";
  const raw = String(inputs.text ?? "").toLowerCase().trim();
  const names = ${JSON.stringify(VEHICLE_NAMES)};
  const vehicle = names[latest.vehicle] || latest.vehicle || (ar ? "\\u0633\\u064a\\u0627\\u0631\\u062a\\u0643" : "your car");
  const firstName = String(lead.full_name || "").trim().split(/\\s+/)[0] || "";
  const has = (words) => words.some((w) => raw.includes(w));

  const cancelled = has(["cancel", "\\u0627\\u0644\\u063a\\u0627\\u0621", "\\u0625\\u0644\\u063a\\u0627\\u0621", "\\u0644\\u0627 \\u0627\\u0628\\u064a", "\\u0644\\u0627 \\u0623\\u0628\\u064a"]);
  const schedule = !cancelled && (raw === "3" || has(["schedule", "later", "\\u0628\\u0639\\u062f\\u064a\\u0646", "\\u0645\\u0648\\u0639\\u062f", "\\u0628\\u0627\\u0643\\u0631", "\\u0628\\u0643\\u0631\\u0647", "\\u0628\\u0643\\u0631\\u0629", "\\u0648\\u0642\\u062a"]));
  const callNow = !cancelled && !schedule && (raw === "2" || has(["call", "\\u0627\\u062a\\u0635\\u0644", "\\u0627\\u062a\\u0635\\u0627\\u0644", "\\u0643\\u0644\\u0645\\u0646\\u064a", "\\u0643\\u0644\\u0645\\u0648\\u0646\\u064a", "\\u0631\\u0646"]));
  const whatsapp = !cancelled && !schedule && !callNow && (raw === "1" || has(["whatsapp", "chat", "text", "message", "\\u0648\\u0627\\u062a\\u0633", "\\u0647\\u0646\\u0627", "\\u0646\\u0643\\u0645\\u0644", "\\u0627\\u0643\\u0645\\u0644", "\\u0623\\u0643\\u0645\\u0644", "\\u0643\\u062a\\u0627\\u0628\\u0647", "\\u0643\\u062a\\u0627\\u0628\\u0629"]));

  const to = String(inputs.mobile ?? "");
  const send = (body) => ({ channelId: "${CHANNEL_ID}", to, type: "text", text: { body, previewUrl: false } });
  const log = (body, kind) => ({ p_mobile: to, p_text: body, p_channel: "whatsapp", p_step: "channel", p_handler: "inbound", p_meta: { kind } });

  let mode = "ask";
  let choice = null;
  let copy = null;
  if (whatsapp) { mode = "set_choice"; choice = "whatsapp"; }
  else if (callNow) { mode = "set_choice"; choice = "call_now"; }
  else if (schedule) { mode = "set_choice"; choice = "schedule"; }
  else if (cancelled) {
    copy = ar
      ? "\\u062a\\u0645 \\u0625\\u0644\\u063a\\u0627\\u0621 \\u0637\\u0644\\u0628\\u0643\\u060c \\u0648\\u0644\\u0627 \\u064a\\u0647\\u0645\\u0643. \\u0625\\u0630\\u0627 \\u062d\\u0628\\u064a\\u062a \\u062a\\u0631\\u062c\\u0639 \\u0644\\u0646\\u0627\\u060c \\u0623\\u0631\\u0633\\u0644 \\u0647\\u0646\\u0627 \\u0628\\u0623\\u064a \\u0648\\u0642\\u062a."
      : "Your request has been cancelled. If you change your mind, just message us here anytime.";
  } else {
    copy = ar
      ? ("\\u0647\\u0644\\u0627" + (firstName ? " " + firstName : "") + "\\u060c \\u0648\\u0635\\u0644\\u0646\\u0627 \\u0637\\u0644\\u0628\\u0643 \\u0639\\u0644\\u0649 " + vehicle + ". \\u062a\\u062d\\u0628 \\u0646\\u0643\\u0645\\u0644 \\u0647\\u0646\\u0627 \\u0628\\u0627\\u0644\\u0648\\u0627\\u062a\\u0633\\u0627\\u0628\\u060c \\u0648\\u0644\\u0627 \\u0646\\u062a\\u0635\\u0644 \\u0639\\u0644\\u064a\\u0643 \\u0627\\u0644\\u062d\\u064a\\u0646\\u060c \\u0648\\u0644\\u0627 \\u0646\\u062d\\u062f\\u062f \\u0644\\u0643 \\u0645\\u0648\\u0639\\u062f \\u0644\\u0644\\u0627\\u062a\\u0635\\u0627\\u0644\\u061f")
      : ("Hi" + (firstName ? " " + firstName : "") + ", we got your request for the " + vehicle + ". Would you like to continue here on WhatsApp, get a call now, or set a time for a call?");
  }

  return {
    mode,
    choice,
    rpcBody: { p_mobile: to, p_choice: choice, p_preferred_call_at: null },
    sendBody: copy ? send(copy) : null,
    logBody: copy ? log(copy, cancelled ? "cancel_ack" : "channel_question") : null,
  };
};
`;

const buildConfirmCode = `export const code = async (inputs) => {
  const pack = inputs.pack || {};
  const lead = pack.lead || {};
  const latest = pack.latest_submission || {};
  const ar = lead.language === "ar";
  const names = ${JSON.stringify(VEHICLE_NAMES)};
  const vehicle = names[latest.vehicle] || latest.vehicle || (ar ? "\\u0633\\u064a\\u0627\\u0631\\u062a\\u0643" : "your car");
  const choice = String(inputs.choice ?? "");
  const windowOpen = pack.call_window === "open";

  let copy;
  if (choice === "whatsapp") {
    copy = ar
      ? "\\u062a\\u0645\\u0627\\u0645\\u060c \\u0646\\u0643\\u0645\\u0644 \\u0647\\u0646\\u0627. \\u0628\\u0633 \\u0623\\u062a\\u0623\\u0643\\u062f \\u0645\\u0646\\u0643 \\u0623\\u0648\\u0644\\u060c \\u0637\\u0644\\u0628\\u0643 \\u0639\\u0644\\u0649 " + vehicle + " \\u0635\\u062d\\u061f"
      : "Great, we will continue here. First, just to confirm - your request is for the " + vehicle + ", right?";
  } else if (choice === "call_now") {
    copy = windowOpen
      ? (ar ? "\\u0623\\u0628\\u0634\\u0631\\u060c \\u0628\\u0646\\u062a\\u0635\\u0644 \\u0639\\u0644\\u064a\\u0643 \\u0627\\u0644\\u062d\\u064a\\u0646 \\u0639\\u0644\\u0649 \\u0647\\u0627\\u0644\\u0631\\u0642\\u0645." : "Sure - we will call you now on this number.")
      : (ar ? "\\u0623\\u0628\\u0634\\u0631\\u060c \\u0628\\u0633 \\u0627\\u0644\\u062d\\u064a\\u0646 \\u0628\\u0631\\u0627 \\u0623\\u0648\\u0642\\u0627\\u062a \\u0627\\u0644\\u0627\\u062a\\u0635\\u0627\\u0644 (\\u0645\\u0646 \\u0669 \\u0627\\u0644\\u0635\\u0628\\u062d \\u0625\\u0644\\u0649 \\u0669 \\u0628\\u0627\\u0644\\u0644\\u064a\\u0644). \\u0628\\u0646\\u062a\\u0635\\u0644 \\u0639\\u0644\\u064a\\u0643 \\u0623\\u0648\\u0644 \\u0645\\u0627 \\u0646\\u0628\\u062f\\u0623 \\u0627\\u0644\\u0633\\u0627\\u0639\\u0629 \\u0669 \\u0627\\u0644\\u0635\\u0628\\u062d\\u060c \\u064a\\u0646\\u0627\\u0633\\u0628\\u0643\\u061f" : "Sure - we are outside calling hours right now (9am to 9pm). We will call you when lines open at 9am, does that work?");
  } else {
    copy = ar
      ? "\\u0623\\u0628\\u0634\\u0631. \\u0648\\u0634 \\u0627\\u0644\\u0648\\u0642\\u062a \\u0627\\u0644\\u0644\\u064a \\u064a\\u0646\\u0627\\u0633\\u0628\\u0643 \\u0646\\u062a\\u0635\\u0644 \\u0639\\u0644\\u064a\\u0643 \\u0641\\u064a\\u0647\\u061f \\u0645\\u062a\\u0627\\u062d\\u064a\\u0646 \\u0645\\u0646 \\u0669 \\u0627\\u0644\\u0635\\u0628\\u062d \\u0625\\u0644\\u0649 \\u0669 \\u0628\\u0627\\u0644\\u0644\\u064a\\u0644."
      : "Sure. What time works best for the call? We are available 9am to 9pm.";
  }

  const to = String(inputs.mobile ?? "");
  return {
    sendBody: { channelId: "${CHANNEL_ID}", to, type: "text", text: { body: copy, previewUrl: false } },
    logBody: { p_mobile: to, p_text: copy, p_channel: "whatsapp", p_step: "channel", p_handler: "inbound", p_meta: { kind: "channel_" + choice } },
  };
};
`;

// ---------------------------------------------------------------- refs

const T = (path) => `{{trigger['output']['body']['${path}']}}`;
const SENDER = T("senderIdentifier");

// ---------------------------------------------------------------- ask_channel branch

const logQuestion = httpNode("log_question", "Store: log question", {
  url: `${SUPABASE_URL}/rest/v1/rpc/record_outbound`,
  headers: storeHeaders,
  bodyData: "{{parse_channel['output']['logBody']}}",
});

const sendQuestion = httpNode("send_question", "WA: channel question / cancel ack", {
  url: `${AF_URL}/messaging/messages`,
  headers: afHeaders,
  bodyData: "{{parse_channel['output']['sendBody']}}",
}, logQuestion);

const logConfirm = httpNode("log_confirm", "Store: log confirmation", {
  url: `${SUPABASE_URL}/rest/v1/rpc/record_outbound`,
  headers: storeHeaders,
  bodyData: "{{build_confirm['output']['logBody']}}",
});

const sendConfirm = httpNode("send_confirm", "WA: choice confirmation", {
  url: `${AF_URL}/messaging/messages`,
  headers: afHeaders,
  bodyData: "{{build_confirm['output']['sendBody']}}",
}, logConfirm);

const buildConfirm = codeNode("build_confirm", "Build confirmation copy", {
  pack: "{{rpc_set_choice['output']['body']}}",
  choice: "{{parse_channel['output']['choice']}}",
  mobile: SENDER,
}, buildConfirmCode, sendConfirm);

const rpcSetChoice = httpNode("rpc_set_choice", "Store: set channel choice", {
  url: `${SUPABASE_URL}/rest/v1/rpc/set_channel_choice`,
  headers: storeHeaders,
  bodyData: "{{parse_channel['output']['rpcBody']}}",
}, buildConfirm);

const routeChoice = router("route_choice", "Choice made?", [
  textMatch("choice made", "{{parse_channel['output']['mode']}}", "set_choice"),
  fallback,
], [rpcSetChoice, sendQuestion]);

const parseChannel = codeNode("parse_channel", "Parse channel reply", {
  pack: "{{store_inbound['output']['body']}}",
  text: T("text"),
  mobile: SENDER,
}, parseChannelCode, routeChoice);

// ---------------------------------------------------------------- gather branch

const logReply = httpNode("log_reply", "Store: log reply", {
  url: `${SUPABASE_URL}/rest/v1/rpc/record_outbound`,
  headers: storeHeaders,
  bodyData: {
    p_mobile: SENDER,
    p_text: "{{chat_generate['output']['body']['data']['message']['content']}}",
    p_channel: "whatsapp",
    p_handler: "inbound",
    p_meta: { kind: "gather_reply" },
  },
});

const sendReply = httpNode("send_reply", "WA: send reply", {
  url: `${AF_URL}/messaging/messages`,
  headers: afHeaders,
  bodyData: {
    channelId: CHANNEL_ID,
    to: SENDER,
    type: "text",
    text: {
      body: "{{chat_generate['output']['body']['data']['message']['content']}}",
      previewUrl: false,
    },
  },
}, logReply);

const chatGenerate = httpNode("chat_generate", "Chat: generate reply", {
  url: `${AF_URL}/chat/message`,
  headers: afHeaders,
  bodyData: {
    channelId: CHANNEL_ID,
    threadKey: SENDER,
    content: T("text"),
    assistantId: ASSISTANT_VAR,
  },
}, sendReply);

// ---------------------------------------------------------------- message.received branch

const routeAction = router("route_action", "Route on next_action", [
  textMatch("ask channel", "{{store_inbound['output']['body']['next_action']}}", "ask_channel"),
  textMatch("gather", "{{store_inbound['output']['body']['next_action']}}", "gather"),
  fallback,
], [parseChannel, chatGenerate, null]);

const storeInbound = httpNode("store_inbound", "Store: record inbound", {
  url: `${SUPABASE_URL}/rest/v1/rpc/record_inbound`,
  headers: storeHeaders,
  bodyData: "{{prep_inbound['output']['body']}}",
}, routeAction);

const prepInbound = codeNode("prep_inbound", "Prepare record_inbound", {
  mobile: SENDER,
  text: T("text"),
  messageType: T("messageType"),
  eventId: T("eventId"),
  messageId: T("messageId"),
  windowState: T("windowState"),
}, prepInboundCode, storeInbound);

// ---------------------------------------------------------------- opt-out branch

const markOptedOut = httpNode("mark_opted_out", "Store: mark opted out", {
  url: `${SUPABASE_URL}/rest/v1/leads?mobile_e164=eq.${SENDER}`,
  method: "PATCH",
  headers: { ...storeHeaders, Prefer: "return=minimal" },
  bodyData: { opted_out: true },
});

// ---------------------------------------------------------------- trigger

const routeEvent = router("route_event", "Route on eventType", [
  textMatch("message received", T("eventType"), "message.received"),
  textMatch("contact opted out", T("eventType"), "contact.opted_out"),
  fallback,
], [prepInbound, markOptedOut, null]);

const flow = {
  name: "Amira Inbound WhatsApp",
  type: "SHARED",
  summary: "Inbound WhatsApp handler: store first, then route on next_action.",
  description:
    "Catch Webhook (channel webhookUrl) -> record_inbound (indexes the message, opens the 24h window, returns the lead pack) -> route: ask_channel (deterministic question / choice parsing), gather (chat assistant), stop. contact.opted_out marks the lead suppressed. Variables required: SUPABASE_SERVICE_ROLE_KEY, AgenticFlow_API_KEY, AMIRA_CHAT_ASSISTANT_ID.",
  tags: ["whatsapp", "inbound", "store"],
  blogUrl: "",
  metadata: {},
  author: "amira",
  categories: [],
  pieces: ["@activepieces/piece-webhook", "@activepieces/piece-http"],
  flows: [
    {
      displayName: "Amira Inbound WhatsApp",
      trigger: {
        name: "trigger",
        valid: true,
        displayName: "Catch Webhook",
        type: "PIECE_TRIGGER",
        settings: {
          pieceName: "@activepieces/piece-webhook",
          pieceVersion: WEBHOOK_VERSION,
          triggerName: "catch_webhook",
          input: { authType: "none", authFields: {} },
          propertySettings: {
            authType: { type: "MANUAL" },
            authFields: { type: "MANUAL", schema: {} },
            liveMarkdown: { type: "MANUAL" },
            syncMarkdown: { type: "MANUAL" },
            testMarkdown: { type: "MANUAL" },
          },
        },
        nextAction: routeEvent,
      },
      valid: true,
      schemaVersion: "22",
      notes: [],
    },
  ],
  status: "PUBLISHED",
};

const here = dirname(fileURLToPath(import.meta.url));

// Template-gallery wrapper (marketplace "SHARED" shape, like whatsapp-messaging.json).
const out = join(here, "amira-inbound-whatsapp.json");
writeFileSync(out, JSON.stringify(flow, null, 2) + "\n");
console.log("wrote", out);

// Single-flow export shape — what the dashboard's Import Flow button expects:
// the FlowVersion object itself, no flows[] wrapper. Use THIS file to import.
const flowVersion = flow.flows[0];
const outFlow = join(here, "amira-inbound-whatsapp.flow.json");
writeFileSync(outFlow, JSON.stringify(flowVersion, null, 2) + "\n");
console.log("wrote", outFlow);

// Paste-ready Code node sources for manual rebuild (decoded Arabic).
import { mkdirSync } from "node:fs";
const decode = (s) =>
  s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
mkdirSync(join(here, "snippets"), { recursive: true });
for (const [file, code] of [
  ["prep_inbound.js", prepInboundCode],
  ["parse_channel.js", parseChannelCode],
  ["build_confirm.js", buildConfirmCode],
]) {
  writeFileSync(join(here, "snippets", file), decode(code));
  console.log("wrote", join(here, "snippets", file));
}
