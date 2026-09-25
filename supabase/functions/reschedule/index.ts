import { createClient } from "npm:@supabase/supabase-js@2";
import { sendTemplate, vehicleLabel } from "../_shared/af.ts";
import { serviceKey } from "../_shared/env.ts";

const WAIT_MS = 15 * 60 * 1000;

function inCallingHours(now = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Riyadh",
    hour: "numeric",
    hourCycle: "h23",
  }).format(now));
  return hour >= 9 && hour < 21;
}

Deno.serve(async () => {
  if (!inCallingHours()) {
    return Response.json({ ok: true, skipped: "outside calling hours" });
  }

  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey());
  const { data: leads, error } = await db
    .from("leads")
    .select("id, mobile_e164, full_name, language, selection, opted_out, last_inbound_at")
    .is("last_inbound_at", null)
    .eq("opted_out", false)
    .limit(50);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

  const sent: string[] = [];
  for (const lead of leads ?? []) {
    const { data: rows } = await db
      .from("messages")
      .select("at, meta")
      .eq("lead_id", lead.id)
      .eq("direction", "out");
    const outbound = rows ?? [];
    const nudged = outbound.some((row) => (row.meta as { kind?: string } | null)?.kind === "followup_nudge");
    if (nudged) continue;
    const opened = outbound
      .filter((row) => (row.meta as { kind?: string } | null)?.kind === "open_template")
      .map((row) => new Date(row.at as string).getTime())
      .sort((a, b) => a - b)[0];
    if (!opened || Date.now() - opened < WAIT_MS) continue;

    const ar = (lead.language ?? "ar") === "ar";
    const vehicle = vehicleLabel((lead.selection as { vehicle?: string } | null)?.vehicle, ar);
    const name = String(lead.full_name ?? "").trim().split(/\s+/)[0] || (ar ? "عميلنا" : "there");
    const template = ar ? "followup_nudge_ar" : "followup_nudge_en";
    const result = await sendTemplate({
      to: lead.mobile_e164,
      name: template,
      language: ar ? "ar" : "en_US",
      params: [name, vehicle],
    });
    if (!result.ok) {
      console.error("follow-up template failed", lead.id, result.status, result.text.slice(0, 240));
      continue;
    }
    await db.rpc("record_outbound", {
      p_mobile: lead.mobile_e164,
      p_text: ar
        ? `مرحبا ${name}، طلبك على ${vehicle} لا زال عندنا. إذا تبي نكمل، راسلنا هنا.`
        : `Hello ${name}, your request for ${vehicle} is still with us. Reply here if you want to continue.`,
      p_channel: "whatsapp",
      p_step: "channel",
      p_handler: "reschedule",
      p_meta: { kind: "followup_nudge", template },
    });
    sent.push(lead.id);
  }

  return Response.json({ ok: true, sent });
});
