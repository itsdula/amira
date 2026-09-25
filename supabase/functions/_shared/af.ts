import { afApiKey } from "./env.ts";
import { findModel, MODELS } from "./catalogue.ts";
import { nextAsk, readSelection, type Pack } from "./brain-contract.ts";

export const AF_BASE = "https://api.ae.agenticflow.studio";
export const CHANNEL_ID = "160e6c61-174a-4de1-b338-ce2e27666c37";
export const PHONE_NUMBER_ID = "a76efc61-6055-4fd0-8943-d79e067cc2d4";
export const CHAT_ASSISTANT_ID = "8ef58e44-6de1-48ec-8d76-189e8595fd7f";
export const VOICE_ASSISTANT_FALLBACK = "bb7401d6-b4ba-45e1-98b2-948a74448ed5";

export const VEHICLE_NAMES: Record<string, string> = {
  ALSVIN: "ALSVIN",
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

export function vehicleLabel(idOrName: string | null | undefined, ar = false): string {
  const raw = String(idOrName ?? "");
  return VEHICLE_NAMES[raw] || raw || (ar ? "سيارتك" : "your car");
}

function headers(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Api-Key": afApiKey() };
}

// AF keys the WhatsApp 24h window on the digits Meta stored. A leading +
// misses that conversation and the send fails with window_closed.
export function afRecipient(mobile: string): string {
  return String(mobile ?? "").trim().replace(/^\+/, "");
}

export async function sendText(to: string, body: string): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(`${AF_BASE}/messaging/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      channelId: CHANNEL_ID,
      to: afRecipient(to),
      type: "text",
      text: { body, previewUrl: false },
    }),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

export async function sendTemplate(opts: {
  to: string;
  name: string;
  language: string;
  params: string[];
}): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(`${AF_BASE}/messaging/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      channelId: CHANNEL_ID,
      to: opts.to,
      type: "template",
      template: {
        name: opts.name,
        language: opts.language,
        components: [
          {
            type: "body",
            parameters: opts.params.map((text) => ({ type: "text", text })),
          },
        ],
      },
    }),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

export function callVariables(pack: Pack, fresh: Record<string, unknown> = {}): Record<string, string> {
  const lead = { ...(pack.lead ?? {}), ...((fresh.lead as Pack["lead"]) ?? {}) };
  const sel = readSelection({ lead, selection: lead.selection ?? pack.selection });
  const full = String(lead.full_name ?? "").trim().split(/\s+/)[0] ?? "";
  const model = findModel(String(sel.vehicle ?? ""));
  const catalogue = model
    ? model.grades.map((g) =>
      `${g.name_en} / ${g.name_ar}: ${g.price_incl_vat_sar} SAR. Colors: ${g.colours.join(", ")}`
    ).join("\n")
    : "Models: " + MODELS.map((m) => m.name).join(", ");
  return {
    customer_name: full,
    gender_form: String(lead.gender_form ?? "unknown"),
    language: String(lead.language ?? "ar"),
    vehicle: String(sel.vehicle ?? ""),
    selection: JSON.stringify(sel),
    empty_field: nextAsk(sel),
    catalogue,
  };
}

export async function placeCall(pack: Pack, fresh: Record<string, unknown> = {}): Promise<string> {
  const assistantId = Deno.env.get("VOICE_ASSISTANT_ID") || VOICE_ASSISTANT_FALLBACK;
  const lead = (fresh.lead ?? pack.lead ?? {}) as Record<string, unknown>;
  try {
    const res = await fetch(`${AF_BASE}/call`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        assistantId,
        phoneNumberId: PHONE_NUMBER_ID,
        customer: {
          number: lead.mobile_e164,
          name: lead.full_name ?? undefined,
          externalId: lead.id,
        },
        metadata: { lead_id: lead.id },
        variables: callVariables(pack, fresh),
      }),
    });
    if (!res.ok) return `dial:failed (http ${res.status}: ${(await res.text()).slice(0, 120)})`;
    return "dial:queued";
  } catch (err) {
    return `dial:failed (${String(err).slice(0, 120)})`;
  }
}
