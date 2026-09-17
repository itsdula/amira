// inbound-brain — the gather/ask brain behind one AF HTTP node.
// POST { pack, text, message_id }  →  { reply, applied, rejected, mode, fallback, latency }
//
// Order inside a call: model → validate → write state (sync) → return reply.
// The reply never leaves before the store is consistent. Logging of the
// outbound itself stays in the flow (record_outbound after the send).
//
// Auth: caller must present the service-role key (same headers the flow
// already uses for PostgREST). verify_jwt=false; this check replaces it.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { findModel } from "../_shared/catalogue.ts";
import { guessGender } from "../_shared/gender.ts";
import {
  Action,
  BrainOutput,
  Pack,
  Rejection,
  replyCompromised,
  validateActions,
} from "../_shared/brain-contract.ts";

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) return JSON.parse(raw)["default"];
  throw new Error("Missing service role key");
}

// A project has multiple valid privileged key formats (legacy JWT +
// sb_secret_*), and the Edge runtime env does not expose all of them.
// String-matching env keys 401s valid callers, so verify FUNCTIONALLY:
// probe PostgREST with the caller's own key against a locked table —
// only a service-level key passes (anon/publishable have no grants).
function envKeys(): Set<string> {
  const keys = new Set<string>();
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) keys.add(legacy);
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      for (const v of Object.values(JSON.parse(raw))) {
        if (typeof v === "string" && v) keys.add(v);
      }
    } catch (_) { /* malformed env — fall through to legacy only */ }
  }
  return keys;
}

const keyVerdicts = new Map<string, boolean>();

async function isPrivileged(k: string): Promise<boolean> {
  if (!k) return false;
  if (envKeys().has(k)) return true; // fast path, no probe
  const cached = keyVerdicts.get(k);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/rest/v1/leads?select=id&limit=1`,
      { method: "HEAD", headers: { apikey: k, Authorization: `Bearer ${k}` } },
    );
    keyVerdicts.set(k, res.ok);
    return res.ok;
  } catch (_) {
    return false;
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------- prompt

const SCHEMA_HINT = `Respond with ONLY a JSON object:
{
  "reply": "message to the customer",
  "actions": [
    {"type": "set_channel", "choice": "whatsapp|call_now|schedule"},
    {"type": "opt_out"},
    {"type": "set_name", "full_name": "..."},
    {"type": "upsert_fact", "key": "vehicle|grade|payment|colours|order_now|accessories|timing", "value": ..., "declined": false},
    {"type": "update_step_context", "narrative": "1-2 sentences", "open_threads": ["..."]},
    {"type": "advance_step", "step": "vehicle|payment|colours|order_gate|accessories|timing|close"}
  ]
}
actions may be empty. Never invent an action type.`;

function catalogueSlice(pack: Pack): string {
  const vehicleFact = pack.facts?.vehicle?.value ?? pack.latest_submission?.vehicle;
  const model = findModel(String(vehicleFact ?? ""));
  if (!model) return "No vehicle chosen yet. Catalogue models: " +
    "ALSVIN, CS 35 Plus, CS 75 Plus, CS 95, EADO Plus, Hunter, UNI-K, UNI S, UNI-T, UNI V.";
  const grades = model.grades.map((g) =>
    `${g.name_en ?? g.name_ar} (${g.name_ar}): ${g.price_incl_vat_sar} SAR incl. VAT; colours: ${g.colours.join(", ")}`
  ).join("\n");
  return `Vehicle on file: ${model.name} (${model.id}).\n${grades}\n` +
    "Showroom extras (tint, PPF, nano) have NO published price - never invent one.";
}

// Static rules — in AF mode these live on the assistant (ASSISTANT_PROMPT.md);
// in OpenAI mode they are part of the system message.
const STATIC_RULES = [
  "You are Amira, a Riyadh showroom advisor for Changan Saudi Arabia, on WhatsApp. Warm, unhurried, professional - the customer should feel hosted, never processed.",
  "If the lead language in [CONTEXT] is ar: reply in Najdi Arabic - colloquial but professional (showroom advisor, not MSA, not street). Latin letters or Arabizi from the customer do NOT switch you to English. If en: natural business English, no Arabic words mixed in.",
  "Rules: ONE question per turn. Never re-ask a fact listed as covered or DECLINED. Never narrate systems (no 'let me save that'). No compliments, no reacting to money. First price mention gets a one-time caveat that prices are preliminary; then quote bare.",
  "ANSWER, THEN ASK - as separate lines: when the customer asks anything, give a complete, warm answer first as its own sentence or list. Then a blank line. Then your one question. Never weld the question onto the answer's tail, and never fire a bare question with no acknowledgment of what they just said.",
  "WHATSAPP FORMATTING: options and choices go as a short dash list (- item), one per line. Use *bold* for the key figure or choice word. Keep messages 2-6 short lines. A blank line separates answer from question.",
  "NAME: never combine asking for the name with any other question - when asking for the name, it is the ONLY question in the message (suggested phrasing: \u0645\u0645\u0643\u0646 \u0627\u0633\u0645\u0643 \u0627\u0644\u0643\u0631\u064a\u0645\u061f). Emit set_name when they give it (also on later corrections). Use their first name occasionally, not every message.",
  "NEVER A DEAD END: every message you send ends with your one question, or with information the customer clearly needs to respond to. A message that just greets or acknowledges with nothing to answer is a defect.",
  "Introduce yourself (\u0645\u0639\u0643 \u0623\u0645\u064a\u0631\u0629 \u0645\u0646 \u0634\u0627\u0646\u062c\u0627\u0646) only in your FIRST message of the conversation - never repeat the introduction in later messages.",
  "GENDER: address by gender_form in [CONTEXT] - m: masculine (تبي/تحب), f: feminine (تبين/تحبين), unknown: neutral phrasing that avoids gendered verbs until known.",
  "Every figure must come from the catalogue data in [CONTEXT]. If it is not there, say you do not have it and move on.",
  "Off-topic or hostile messages: one short graceful line, then return to your question. Never a dead end.",
].join("\n");

// Per-turn context — travels with every call in both modes.
function dynamicContext(pack: Pack, mode: "ask_channel" | "gather"): string {
  const lead = pack.lead ?? {};
  const nameKnown = Boolean(lead.full_name?.trim());
  const facts = Object.entries(pack.facts ?? {})
    .map(([k, v]) => `${k}=${v.declined ? "DECLINED" : JSON.stringify(v.value)}`)
    .join(", ") || "none";

  // One goal per turn. When the name is unknown, the channel/qualification
  // goal is deliberately absent from the prompt so the model cannot merge
  // two questions into one message.
  const goal = !nameKnown
    ? "GOAL NOW: the customer's name is unknown. TWO CASES: (a) their latest message GIVES a name -> emit set_name, greet them by it, and ask the channel question as your one question: continue here on WhatsApp, a call now, or schedule a call time (emit set_channel if they also implied a choice). (b) their message does NOT give a name -> briefly handle whatever they said, then ask ONLY for their name; do not mention WhatsApp/call/schedule this turn. Either way the message must end with a question. If they clearly want no contact, emit opt_out."
    : mode === "ask_channel"
      ? "GOAL NOW: the customer has not picked a channel. Briefly handle whatever they said, then ask: continue here on WhatsApp, a call now, or schedule a call time? If their message already implies a choice, emit set_channel. If they clearly want no contact, emit opt_out."
      : "GOAL NOW: qualify. Ask only the next uncovered fact in order. Emit upsert_fact for every answer (including declines: declined=true), update_step_context with a short narrative, and advance_step when the current step's fact is covered.";

  return [
    `Lead language: ${lead.language ?? "ar"}.`,
    `Customer name: ${nameKnown ? lead.full_name : "UNKNOWN"}. gender_form: ${lead.gender_form ?? "unknown"}.`,
    `Covered facts: ${facts}`,
    `Current step: ${lead.current_step}. Qualification order: vehicle -> payment -> colours -> order_gate -> accessories (only if order_now=true) -> timing -> close.`,
    goal,
    "--- CATALOGUE ---",
    catalogueSlice(pack),
  ].join("\n");
}

function systemPrompt(pack: Pack, mode: "ask_channel" | "gather"): string {
  return [STATIC_RULES, dynamicContext(pack, mode), "--- OUTPUT ---", SCHEMA_HINT].join("\n");
}

function transcript(pack: Pack & { recent_messages?: { direction: string; text: string }[] }, text: string): string {
  const recent = (pack.recent_messages ?? []).slice(0, 8).reverse()
    .map((m) => `${m.direction === "in" ? "Customer" : m.direction === "out" ? "Amira" : "System"}: ${m.text}`)
    .join("\n");
  return `${recent}\nCustomer: ${text}`;
}

// ---------------------------------------------------------------- fallbacks

function fallbackReply(pack: Pack, mode: "ask_channel" | "gather"): string {
  const ar = (pack.lead?.language ?? "ar") === "ar";
  if (mode === "ask_channel") {
    return ar
      ? "تحب نكمل هنا بالواتساب، ولا نتصل عليك الحين، ولا نحدد لك موعد للاتصال؟"
      : "Would you like to continue here on WhatsApp, get a call now, or set a time for a call?";
  }
  const step = pack.lead?.current_step ?? "vehicle";
  const q: Record<string, [string, string]> = {
    vehicle: ["بس أتأكد، أي سيارة تبي نكمل عليها؟", "Just to confirm - which car should we continue with?"],
    payment: ["تحب تدفع كاش، ولا تمويل، ولا إيجار منتهي بالتمليك؟", "Would you pay cash, finance, or lease?"],
    colours: ["وش الألوان اللي تفضلها؟ رتب لي أول وثاني وثالث اختيار.", "Which colours do you prefer? Give me your 1st, 2nd and 3rd choice."],
    order_gate: ["تبينا نمشي لك بالطلب الحين؟", "Shall we raise the order for you now?"],
    accessories: ["تحب نضيف تظليل أو حماية للسيارة؟", "Would you like tint or protection added?"],
    timing: ["ناوي تشتري الحين، ولا بعد شهر أو أكثر؟", "Are you buying now, or in a month or more?"],
    close: ["عطنا لحظة ونرجع لك بالملخص.", "One moment and we will send your summary."],
  };
  const pair = q[step] ?? q.vehicle;
  return ar ? pair[0] : pair[1];
}

// ---------------------------------------------------------------- model

// Tolerant JSON extraction: harnesses sometimes wrap JSON in prose or fences.
function extractJson(content: string): BrainOutput | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    if (typeof parsed?.reply !== "string") return null;
    return { reply: parsed.reply, actions: Array.isArray(parsed.actions) ? parsed.actions : [] };
  } catch {
    return null;
  }
}

type ModelResult = { out: BrainOutput | null; ms: number; provider: string; error?: string };

// Primary: AgenticFlow /chat/message — the workspace-provisioned models.
// The static rules + JSON schema live on the assistant (see ASSISTANT_PROMPT.md);
// per-turn context is prepended to the message content.
async function callModelAF(dynamicContext: string, user: string, mobile: string): Promise<ModelResult | null> {
  const afKey = Deno.env.get("AGENTICFLOW_API_KEY");
  const assistantId = Deno.env.get("BRAIN_AF_ASSISTANT_ID");
  if (!afKey || !assistantId) return null; // AF mode not configured
  const channelId = "160e6c61-174a-4de1-b338-ce2e27666c37";

  const t0 = performance.now();
  try {
    const res = await fetch("https://api.ae.agenticflow.studio/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": afKey },
      body: JSON.stringify({
        channelId,
        threadKey: mobile,
        assistantId,
        content: `[CONTEXT]\n${dynamicContext}\n[CONVERSATION]\n${user}\n\nRespond with ONLY the JSON object.`,
      }),
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { out: null, ms, provider: "af", error: `af http ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    const content = data?.data?.message?.content ?? data?.message?.content ?? "";
    const out = extractJson(String(content));
    return { out, ms, provider: "af", error: out ? undefined : "schema: could not parse assistant JSON" };
  } catch (err) {
    return { out: null, ms: Math.round(performance.now() - t0), provider: "af", error: String(err).slice(0, 200) };
  }
}

// Secondary: any OpenAI-compatible endpoint (BRAIN_API_KEY / BRAIN_API_URL / BRAIN_MODEL).
async function callModelOpenAI(system: string, user: string): Promise<ModelResult> {
  const key = Deno.env.get("BRAIN_API_KEY");
  if (!key) return { out: null, ms: 0, provider: "none", error: "no model configured (set BRAIN_AF_ASSISTANT_ID + AGENTICFLOW_API_KEY, or BRAIN_API_KEY)" };
  const url = Deno.env.get("BRAIN_API_URL") ?? "https://api.openai.com/v1/chat/completions";
  const model = Deno.env.get("BRAIN_MODEL") ?? "gpt-4o-mini";

  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 600,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { out: null, ms, provider: "openai", error: `model http ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    const out = extractJson(String(data?.choices?.[0]?.message?.content ?? ""));
    return { out, ms, provider: "openai", error: out ? undefined : "schema: reply missing" };
  } catch (err) {
    return { out: null, ms: Math.round(performance.now() - t0), provider: "openai", error: String(err).slice(0, 200) };
  }
}

async function callModel(system: string, dynamicContext: string, user: string, mobile: string): Promise<ModelResult> {
  const af = await callModelAF(dynamicContext, user, mobile);
  if (af) return af; // AF configured: its result stands (retry handled by caller)
  return await callModelOpenAI(system, user);
}

// ---------------------------------------------------------------- executor

async function execute(
  db: SupabaseClient,
  pack: Pack,
  accepted: Action[],
  messageId: string | null,
): Promise<string[]> {
  const applied: string[] = [];
  const leadId = pack.lead?.id;
  const mobile = pack.lead?.mobile_e164 ?? null;
  if (!leadId) return applied;
  const step = pack.lead?.current_step ?? "channel";

  for (const action of accepted) {
    switch (action.type) {
      case "set_channel": {
        const { error } = await db.rpc("set_channel_choice", {
          p_mobile: mobile,
          p_choice: action.choice,
          p_preferred_call_at: action.preferred_call_at ?? null,
        });
        if (!error) applied.push(`set_channel:${action.choice}`);
        break;
      }
      case "opt_out": {
        const { error } = await db.from("leads").update({ opted_out: true }).eq("id", leadId);
        if (!error) applied.push("opt_out");
        break;
      }
      case "set_name": {
        const fullName = String(action.full_name).trim();
        const gender = guessGender(fullName);
        const { error } = await db.from("leads")
          .update({ full_name: fullName, gender_form: gender })
          .eq("id", leadId);
        if (!error) {
          await db.rpc("upsert_fact", {
            p_lead_id: leadId,
            p_key: "full_name",
            p_value: fullName,
            p_declined: false,
            p_step: step,
            p_channel: "whatsapp",
            p_message_id: messageId,
          });
          applied.push(`set_name:${gender}`);
        }
        break;
      }
      case "upsert_fact": {
        const { error } = await db.rpc("upsert_fact", {
          p_lead_id: leadId,
          p_key: action.key,
          p_value: action.declined ? null : action.value,
          p_declined: action.declined ?? false,
          p_step: step,
          p_channel: "whatsapp",
          p_message_id: messageId,
        });
        if (!error) applied.push(`fact:${action.key}`);
        break;
      }
      case "update_step_context": {
        const { error } = await db.from("step_contexts").upsert({
          lead_id: leadId,
          step,
          status: "in_progress",
          narrative: action.narrative ?? null,
          open_threads: action.open_threads ?? [],
        }, { onConflict: "lead_id,step" });
        if (!error) applied.push("step_context");
        break;
      }
      case "advance_step": {
        const { error } = await db.from("leads").update({ current_step: action.step }).eq("id", leadId);
        if (!error) applied.push(`step:${action.step}`);
        break;
      }
    }
  }
  return applied;
}

// ---------------------------------------------------------------- handler

Deno.serve(async (req) => {
  const t0 = performance.now();
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const apikey = req.headers.get("apikey") ?? "";
  if (!(await isPrivileged(apikey)) && !(await isPrivileged(bearer))) {
    return json(401, { error: "unauthorized" });
  }
  const key = serviceKey();

  let body: { pack?: Pack; text?: string; message_id?: string | null };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad json" });
  }
  const pack = body.pack;
  const text = String(body.text ?? "").trim();
  if (!pack?.lead?.id) return json(400, { error: "pack.lead.id required" });
  if (pack.lead.opted_out) return json(200, { reply: null, applied: [], rejected: [], mode: "stopped", fallback: false });

  const mode: "ask_channel" | "gather" = pack.next_action === "ask_channel" ? "ask_channel" : "gather";
  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", key);

  // model → validate → write → reply
  const system = systemPrompt(pack, mode);
  const context = dynamicContext(pack, mode);
  const convo = transcript(pack as Parameters<typeof transcript>[0], text);
  const mobile = pack.lead.mobile_e164 ?? "";
  let attempt = await callModel(system, context, convo, mobile);
  if (!attempt.out && !attempt.error?.startsWith("no model configured")) {
    attempt = await callModel(system, context, convo, mobile);
  }

  let reply: string;
  let applied: string[] = [];
  let rejected: Rejection[] = [];
  let fallback = false;

  if (attempt.out) {
    const verdict = validateActions(pack, attempt.out.actions);
    rejected = verdict.rejected;
    applied = await execute(db, pack, verdict.accepted, body.message_id ?? null);
    if (replyCompromised(verdict.rejected)) {
      reply = fallbackReply(pack, mode);
      fallback = true;
    } else {
      reply = attempt.out.reply;
    }
  } else {
    reply = fallbackReply(pack, mode);
    fallback = true;
  }

  const totalMs = Math.round(performance.now() - t0);

  // audit row — what the model tried, what the executor decided, where time went
  await db.from("messages").insert({
    lead_id: pack.lead.id,
    channel: "whatsapp",
    direction: "system",
    text: `brain ${mode}: applied [${applied.join(", ")}]` +
      (rejected.length ? ` rejected [${rejected.map((r) => `${r.action.type}: ${r.reason}`).join("; ")}]` : "") +
      (attempt.error ? ` error [${attempt.error}]` : ""),
    lang: pack.lead.language ?? null,
    step: pack.lead.current_step ?? null,
    handler: "inbound",
    meta: { kind: "brain_audit", mode, applied, rejected, fallback, provider: attempt.provider, model_ms: attempt.ms, total_ms: totalMs, model_error: attempt.error ?? null },
  });

  return json(200, {
    reply,
    applied,
    rejected,
    mode,
    fallback,
    latency: { model_ms: attempt.ms, total_ms: totalMs },
  });
});
