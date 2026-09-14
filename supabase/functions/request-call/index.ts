import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { isVehicleId } from "../_shared/vehicles.ts";

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

  const payload = {
    id: lead.id,
    submissionId: pack.submission_id,
    fullName: lead.full_name,
    mobileE164: lead.mobile_e164,
    vehicle: latest.vehicle ?? vehicle,
    language: lead.language,
    consentWhatsapp: lead.consent_whatsapp,
    submittedAt: latest.submitted_at ?? submittedAt,
    template: "callback_request_confirm",
    templateLanguage: lead.language === "ar" ? "ar" : "en_US",
  };

  const webhookUrl = Deno.env.get("FORM_WEBHOOK_URL");
  if (!webhookUrl) {
    console.error("FORM_WEBHOOK_URL is not set; skipped template webhook.");
  } else if (!pack.send_template) {
    console.info("Skipped template webhook (no consent or opted out).");
  } else {
    try {
      const hook = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!hook.ok) {
        console.error("Form webhook failed", hook.status, await hook.text());
      }
    } catch (err) {
      console.error("Form webhook error", err);
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
