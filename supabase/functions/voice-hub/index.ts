// voice-hub — receives the voice assistant's webhooks (end-of-call-report,
// status-update, transcript) and lands calls in the store:
//   - transcript + summary + analysis  -> messages (channel=voice)
//   - analysis.structuredData          -> validated fact writes (same value
//     checks as the WhatsApp brain; the model never writes the store directly)
//   - full_name                        -> lead name + gender guess
//
// Auth: HMAC-SHA256 of the raw body with VOICE_HUB_SECRET, from the
// X-Webhook-Signature header. Accepts both "hex" and "t=<ts>,v1=<hex>" forms.

import { createClient } from "npm:@supabase/supabase-js@2";
import { checkFactValue, Pack } from "../_shared/brain-contract.ts";
import { guessGender } from "../_shared/gender.ts";

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

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifySignature(raw: string, header: string, secret: string): Promise<boolean> {
  if (!header) return false;
  if (header.includes("v1=")) {
    const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
    const expected = await hmacHex(secret, `v1:${parts["t"]}:${raw}`);
    return parts["v1"] === expected;
  }
  const bare = header.replace(/^sha256=/, "");
  return bare === await hmacHex(secret, raw);
}

function normalizeMobile(m: string): string {
  const t = String(m ?? "").trim();
  return t && !t.startsWith("+") ? `+${t}` : t;
}

const FACT_KEYS = ["vehicle", "grade", "payment", "colours", "order_now", "accessories", "timing"] as const;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const raw = await req.text();
  const secret = Deno.env.get("VOICE_HUB_SECRET") ?? "";
  const signature = req.headers.get("x-webhook-signature") ?? "";
  if (!secret || !(await verifySignature(raw, signature, secret))) {
    return json(401, { error: "unauthorized" });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "bad json" });
  }

  // Envelope tolerance: the call object may be at body.call or body itself.
  const call = (body.call ?? body) as Record<string, unknown>;
  const eventType = String(body.type ?? body.eventType ?? body.event ?? "unknown");
  const customer = (call.customer ?? {}) as { number?: string; name?: string };
  const metadata = (body.metadata ?? call.metadata ?? {}) as { lead_id?: string };
  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey());

  // Only the end-of-call report writes; other events are acknowledged.
  const isReport = eventType.includes("end-of-call") ||
    Boolean(call.transcript) && Boolean(call.endedAt);
  if (!isReport) return json(200, { ok: true, ignored: eventType });

  // Resolve the lead: echoed metadata first, then the dialed number.
  let leadId = metadata.lead_id ?? null;
  let lead: Record<string, unknown> | null = null;
  if (leadId) {
    const { data } = await db.from("leads").select("*").eq("id", leadId).maybeSingle();
    lead = data;
  }
  if (!lead && customer.number) {
    const { data } = await db.from("leads").select("*")
      .eq("mobile_e164", normalizeMobile(customer.number)).maybeSingle();
    lead = data;
  }
  if (!lead) return json(200, { ok: false, reason: "no matching lead" });
  leadId = String(lead.id);

  const analysis = (call.analysis ?? {}) as {
    summary?: string;
    successEvaluation?: string;
    structuredData?: Record<string, unknown>;
  };
  const transcript = String(call.transcript ?? "");
  const durationSeconds = Number(call.durationSeconds ?? 0);
  const endedReason = String(call.endedReason ?? "");

  // 1. Transcript + summary into the chat log (channel=voice).
  await db.from("messages").insert({
    lead_id: leadId,
    channel: "voice",
    direction: "system",
    text: `voice call report (${endedReason || "ended"}, ${durationSeconds}s)\n` +
      (analysis.summary ? `SUMMARY: ${analysis.summary}\n` : "") +
      (transcript ? `TRANSCRIPT:\n${transcript}` : "(no transcript)"),
    lang: (lead.language as string) ?? null,
    step: (lead.current_step as string) ?? null,
    handler: "inbound",
    meta: {
      kind: "voice_call_report",
      call_id: call.id ?? null,
      ended_reason: endedReason,
      duration_seconds: durationSeconds,
      success_evaluation: analysis.successEvaluation ?? null,
      structured_data: analysis.structuredData ?? null,
    },
  });

  // 2. Validated fact writes from structuredData — same value checks as chat.
  // Seed the pack with facts already stored (e.g. vehicle chosen in chat) so
  // vehicle-dependent checks (grade, colours) validate against the real state.
  const { data: existingFacts } = await db.from("facts")
    .select("key,value,declined").eq("lead_id", leadId);
  const factMap = Object.fromEntries(
    (existingFacts ?? []).map((f) => [f.key, { value: f.value, declined: f.declined }]),
  );
  const sd = analysis.structuredData ?? {};
  const pack: Pack = { lead: lead as Pack["lead"], facts: factMap, latest_submission: { vehicle: null } };
  const applied: string[] = [];
  const rejected: string[] = [];

  for (const key of FACT_KEYS) {
    const value = sd[key];
    if (value === undefined || value === null || value === "unknown" || value === "") continue;
    const problem = checkFactValue(pack, key, value, false);
    if (problem) {
      rejected.push(`${key}: ${problem}`);
      continue;
    }
    const { error } = await db.rpc("upsert_fact", {
      p_lead_id: leadId,
      p_key: key,
      p_value: value,
      p_declined: false,
      p_step: (lead.current_step as string) ?? "vehicle",
      p_channel: "voice",
      p_message_id: null,
    });
    if (!error) applied.push(key);
    // Keep the pack's vehicle fresh so grade/colours validate against it.
    if (!error && key === "vehicle") {
      pack.facts = { ...pack.facts, vehicle: { value, declined: false } };
    }
  }

  const fullName = String(sd.full_name ?? "").trim();
  if (fullName && fullName.toLowerCase() !== "unknown" && !lead.full_name) {
    const gender = guessGender(fullName);
    const { error } = await db.from("leads")
      .update({ full_name: fullName, gender_form: gender }).eq("id", leadId);
    if (!error) applied.push(`full_name:${gender}`);
  }

  // Audit row mirroring the brain's shape. (No-answer retry policy belongs to
  // the ghost service; the report row above carries ended_reason for it.)
  await db.from("messages").insert({
    lead_id: leadId,
    channel: "voice",
    direction: "system",
    text: `voice-hub: applied [${applied.join(", ")}]` +
      (rejected.length ? ` rejected [${rejected.join("; ")}]` : ""),
    lang: (lead.language as string) ?? null,
    step: (lead.current_step as string) ?? null,
    handler: "inbound",
    meta: { kind: "voice_audit", applied, rejected, ended_reason: endedReason },
  });

  return json(200, { ok: true, applied, rejected });
});
