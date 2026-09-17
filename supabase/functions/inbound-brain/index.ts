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

function systemPrompt(pack: Pack, mode: "ask_channel" | "gather"): string {
  const lead = pack.lead ?? {};
  const ar = lead.language === "ar";
  const facts = Object.entries(pack.facts ?? {})
    .map(([k, v]) => `${k}=${v.declined ? "DECLINED" : JSON.stringify(v.value)}`)
    .join(", ") || "none";

  return [
    "You are Amira, a Riyadh showroom advisor for Changan Saudi Arabia, on WhatsApp.",
    ar
      ? "Reply in Najdi Arabic - colloquial but professional (showroom advisor, not MSA, not street). Latin letters or Arabizi from the customer do NOT switch you to English."
      : "Reply in natural business English. No Arabic words mixed in.",
    "Rules: ONE question per turn. Answer their question first, then ask yours. Never re-ask a fact listed as covered or DECLINED. Never narrate systems (no 'let me save that'). No compliments, no reacting to money. First price mention gets a one-time caveat that prices are preliminary; then quote bare.",
    "Every figure must come from the catalogue data below. If it is not there, say you do not have it and move on.",
    `Covered facts: ${facts}`,
    `Current step: ${lead.current_step}. Qualification order: vehicle -> payment -> colours -> order_gate -> accessories (only if order_now=true) -> timing -> close.`,
    mode === "ask_channel"
      ? "GOAL NOW: the customer has not picked a channel. Briefly handle whatever they said, then ask: continue here on WhatsApp, a call now, or schedule a call time? If their message already implies a choice, emit set_channel. If they clearly want no contact, emit opt_out."
      : "GOAL NOW: qualify. Ask only the next uncovered fact in order. Emit upsert_fact for every answer (including declines: declined=true), update_step_context with a short narrative, and advance_step when the current step's fact is covered.",
    "Off-topic or hostile messages: one short graceful line, then return to your question. Never a dead end.",
    "--- CATALOGUE ---",
    catalogueSlice(pack),
    "--- OUTPUT ---",
    SCHEMA_HINT,
  ].join("\n");
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

async function callModel(system: string, user: string): Promise<{ out: BrainOutput | null; ms: number; error?: string }> {
  const key = Deno.env.get("BRAIN_API_KEY");
  if (!key) return { out: null, ms: 0, error: "BRAIN_API_KEY not set" };
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
    if (!res.ok) return { out: null, ms, error: `model http ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content);
    if (typeof parsed?.reply !== "string") return { out: null, ms, error: "schema: reply missing" };
    return { out: { reply: parsed.reply, actions: Array.isArray(parsed.actions) ? parsed.actions : [] }, ms };
  } catch (err) {
    return { out: null, ms: Math.round(performance.now() - t0), error: String(err).slice(0, 200) };
  }
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

  const key = serviceKey();
  const auth = req.headers.get("authorization") ?? "";
  const apikey = req.headers.get("apikey") ?? "";
  if (auth !== `Bearer ${key}` && apikey !== key) {
    return json(401, { error: "unauthorized" });
  }

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
  let attempt = await callModel(systemPrompt(pack, mode), transcript(pack as Parameters<typeof transcript>[0], text));
  if (!attempt.out && !attempt.error?.startsWith("BRAIN_API_KEY")) {
    attempt = await callModel(systemPrompt(pack, mode), transcript(pack as Parameters<typeof transcript>[0], text));
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
    meta: { kind: "brain_audit", mode, applied, rejected, fallback, model_ms: attempt.ms, total_ms: totalMs, model_error: attempt.error ?? null },
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
