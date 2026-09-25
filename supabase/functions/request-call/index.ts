import { createClient } from "npm:@supabase/supabase-js@2";
import { sendTemplate, vehicleLabel } from "../_shared/af.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { serviceKey } from "../_shared/env.ts";
import { guessGender } from "../_shared/gender.ts";
import { isVehicleId } from "../_shared/vehicles.ts";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function asBool(value: unknown): boolean {
  return value === true || value === "true" || value === "on" || value === "1";
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "POST only." });
  }

  let raw: Record<string, unknown> = {};
  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      raw = await req.json();
    } else {
      const form = await req.formData();
      raw = Object.fromEntries(form.entries());
    }
  } catch {
    return json(400, { error: "Could not read body." });
  }

  const fullName = asString(raw.fullName);
  const mobileE164 = asString(raw.mobileE164).replace(/\s+/g, "");
  const vehicle = asString(raw.vehicle);
  const language = asString(raw.language).toLowerCase();
  const consentWhatsapp = asBool(raw.consentWhatsapp);
  const submittedAt = new Date().toISOString();

  if (!fullName) return json(400, { error: "fullName is required." });
  if (!/^\+[1-9]\d{7,14}$/.test(mobileE164)) {
    return json(400, { error: "mobileE164 must be E.164, e.g. +9665XXXXXXXX." });
  }
  if (!isVehicleId(vehicle)) {
    return json(400, { error: "vehicle is not in the catalogue." });
  }
  if (language !== "en" && language !== "ar") {
    return json(400, { error: "language must be en or ar." });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey());
  const { data, error } = await supabase.rpc("ingest_form_submission", {
    p_full_name: fullName,
    p_mobile: mobileE164,
    p_vehicle: vehicle,
    p_language: language,
    p_consent: consentWhatsapp,
    p_submitted_at: submittedAt,
  });

  type IngestResult = {
    lead?: {
      id: string;
      full_name: string;
      mobile_e164: string;
      language: string;
      consent_whatsapp: boolean;
    };
    latest_submission?: { vehicle?: string; submitted_at?: string };
    send_template?: boolean;
    submission_id?: string;
  };
  const pack = (data ?? {}) as IngestResult;

  if (error || !pack.lead?.id) {
    console.error(error ?? "ingest_form_submission returned no lead");
    return json(500, { error: "Could not save the request." });
  }

  const lead = pack.lead;
  const latest = pack.latest_submission ?? {};
  const gender = guessGender(lead.full_name);
  if (gender !== "unknown") {
    await supabase.from("leads").update({ gender_form: gender }).eq("id", lead.id);
  }

  const chosenVehicle = latest.vehicle ?? vehicle;
  if (pack.send_template) {
    const ar = lead.language === "ar";
    try {
      const name = ar ? "callback_request_confirm_ar" : "callback_request_confirm_en";
      const params = [lead.full_name.split(/\s+/)[0] || lead.full_name, vehicleLabel(chosenVehicle, ar)];
      let sent = await sendTemplate({
        to: lead.mobile_e164,
        name,
        language: ar ? "ar" : "en_US",
        params,
      });
      if (!sent.ok && ar) {
        sent = await sendTemplate({ to: lead.mobile_e164, name, language: "en_US", params });
      }
      if (!sent.ok) {
        console.error("Form template send failed", sent.status, sent.text.slice(0, 300));
      } else {
        await supabase.rpc("record_outbound", {
          p_mobile: lead.mobile_e164,
          p_text: `template ${ar ? "callback_request_confirm_ar" : "callback_request_confirm_en"}`,
          p_channel: "whatsapp",
          p_step: "channel",
          p_handler: "form",
          p_meta: { kind: "open_template", language: ar ? "ar" : "en_US" },
        });
      }
    } catch (err) {
      console.error("Form template send error", err);
    }
  }

  return json(200, {
    id: lead.id,
    submissionId: pack.submission_id,
    fullName: lead.full_name,
    mobileE164: lead.mobile_e164,
    vehicle: latest.vehicle ?? vehicle,
    language: lead.language,
    consentWhatsapp: lead.consent_whatsapp,
    submittedAt: latest.submitted_at ?? submittedAt,
  });
});
