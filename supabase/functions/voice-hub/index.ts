// voice-hub — receives the voice assistant's webhooks (end-of-call-report,
// status-update, transcript) and lands calls in the store:
//   - transcript + summary + analysis  -> messages (channel=voice)
//   - analysis.structuredData          -> validated selection patch
//   - full_name                        -> lead name + gender guess
//
// Auth: HMAC-SHA256 of the raw body with VOICE_HUB_SECRET, from the
// X-Webhook-Signature header. Accepts both "hex" and "t=<ts>,v1=<hex>" forms.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  applySelectionPatch,
  looksLikeVehicleName,
  nextAsk,
  Pack,
  readSelection,
  SELECTION_KEYS,
  Selection,
  leadTemperature,
} from "../_shared/brain-contract.ts";
import { guessGender } from "../_shared/gender.ts";
import { sendTemplate } from "../_shared/af.ts";
import { closingTemplate } from "../_shared/brain-turn.ts";

import { serviceKey } from "../_shared/env.ts";
import { verifySignature } from "../_shared/hmac.ts";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}


function normalizeMobile(m: string): string {
  const t = String(m ?? "").trim();
  return t && !t.startsWith("+") ? `+${t}` : t;
}

function fieldsFromStructuredData(sd: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of SELECTION_KEYS) {
    const value = sd[key];
    if (value === undefined || value === null || value === "unknown" || value === "") continue;
    fields[key] = value;
  }
  if (Array.isArray(fields.accessories) && fields.accessories.length === 1 && fields.accessories[0] === "none") {
    fields.accessories = "none";
  }
  if (fields.color === undefined && (sd.colours !== undefined || sd.colour !== undefined)) {
    const raw = sd.colours ?? sd.colour;
    fields.color = Array.isArray(raw) ? raw[0] : raw;
  }
  return fields;
}

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

  const call = (body.call ?? body) as Record<string, unknown>;
  const eventType = String(body.type ?? body.eventType ?? body.event ?? "unknown");
  const customer = (call.customer ?? {}) as { number?: string; name?: string };
  const metadata = (body.metadata ?? call.metadata ?? {}) as { lead_id?: string };
  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey());

  const isReport = eventType.includes("end-of-call") ||
    Boolean(call.transcript) && Boolean(call.endedAt);
  if (!isReport) return json(200, { ok: true, ignored: eventType });

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
  const step = (lead.current_step as string) ?? nextAsk(readSelection({ lead: lead as Pack["lead"] }));

  await db.from("messages").insert({
    lead_id: leadId,
    channel: "voice",
    direction: "system",
    text: `voice call report (${endedReason || "ended"}, ${durationSeconds}s)\n` +
      (analysis.summary ? `SUMMARY: ${analysis.summary}\n` : "") +
      (transcript ? `TRANSCRIPT:\n${transcript}` : "(no transcript)"),
    lang: (lead.language as string) ?? null,
    step,
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

  const pack: Pack = { lead: lead as Pack["lead"], selection: (lead.selection as Selection) ?? null };
  const fields = fieldsFromStructuredData(analysis.structuredData ?? {});
  const result = applySelectionPatch(readSelection(pack), fields);
  const applied: string[] = [];
  const rejected = result.rejected.map((r) => `${r.key}: ${r.reason}`);

  if (Object.keys(result.accepted).length > 0) {
    const { error } = await db.rpc("patch_selection", {
      p_lead_id: leadId,
      p_fields: result.accepted,
    });
    if (!error) applied.push(`selection:${Object.keys(result.accepted).join(",")}`);
    else rejected.push(`patch_selection: ${error.message}`);
  }

  const fullName = String(analysis.structuredData?.full_name ?? "").trim();
  if (fullName && fullName.toLowerCase() !== "unknown" && !lead.full_name && !looksLikeVehicleName(fullName)) {
    const gender = guessGender(fullName);
    const { error } = await db.from("leads")
      .update({ full_name: fullName, gender_form: gender }).eq("id", leadId);
    if (!error) applied.push(`full_name:${gender}`);
  }

  const missed = /no-answer|customer-did-not-answer|busy|failed/i.test(endedReason);
  if (!missed && lead.status !== "hot" && lead.status !== "cold" && !lead.opted_out && nextAsk(result.next) === "close") {
    const temp = leadTemperature(result.next);
    const { error: statusError } = await db.from("leads").update({ status: temp, current_channel: "voice" }).eq("id", leadId);
    if (!statusError) {
      applied.push(`status:${temp}`);
      const closing = closingTemplate({ lead: { ...(lead as Pack["lead"]), selection: result.next } }, temp);
      const sent = await sendTemplate({
        to: String(lead.mobile_e164),
        name: closing.name,
        language: closing.language,
        params: closing.params,
      });
      applied.push(sent.ok ? "closing_template" : `closing_template_failed:${sent.status}`);
    }
  }

  await db.from("messages").insert({
    lead_id: leadId,
    channel: "voice",
    direction: "system",
    text: `voice-hub: applied [${applied.join(", ")}]` +
      (rejected.length ? ` rejected [${rejected.join("; ")}]` : ""),
    lang: (lead.language as string) ?? null,
    step,
    handler: "inbound",
    meta: { kind: "voice_audit", applied, rejected, ended_reason: endedReason },
  });

  return json(200, { ok: true, applied, rejected });
});
