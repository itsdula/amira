// inbound — WhatsApp channel webhook. Meta → AF channel → this function.
// Auth: HMAC on X-Webhook-Signature with CHANNEL_WEBHOOK_SECRET.
// Index the inbound text first, then reply, then send via the AF messaging API.

import { createClient } from "npm:@supabase/supabase-js@2";
import { CHANNEL_ID, placeCall, sendTemplate, sendText, vehicleLabel } from "../_shared/af.ts";
import { runBrainTurn } from "../_shared/brain-turn.ts";
import { cancelCopy, confirmCopy, detectChannel, parseInboundEvent } from "../_shared/channel.ts";
import { serviceKey } from "../_shared/env.ts";
import { verifySignature } from "../_shared/hmac.ts";
import { sayLease, stripEmoji, type Pack } from "../_shared/brain-contract.ts";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function finish(work: Promise<unknown>) {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(work);
    return;
  }
  await work;
}

async function alreadySeen(db: ReturnType<typeof createClient>, eventId: string | null): Promise<boolean> {
  if (!eventId) return false;
  const { data } = await db.from("messages").select("id").contains("meta", { event_id: eventId }).limit(1);
  return Boolean(data && data.length > 0);
}

async function sendAndLog(
  db: ReturnType<typeof createClient>,
  mobile: string,
  copy: string,
  meta: Record<string, unknown>,
  step?: string,
) {
  const clean = sayLease(stripEmoji(copy));
  const sent = await sendText(mobile, clean);
  if (!sent.ok) {
    console.error("sendText failed", sent.status, sent.text.slice(0, 200));
  }
  await db.rpc("record_outbound", {
    p_mobile: mobile,
    p_text: clean,
    p_channel: "whatsapp",
    p_step: step ?? null,
    p_handler: "inbound",
    p_meta: {
      ...meta,
      send_ok: sent.ok,
      send_status: sent.status,
      send_error: sent.ok ? null : sent.text.slice(0, 300),
    },
  });
}

async function continueTurn(
  db: ReturnType<typeof createClient>,
  pack: Pack,
  parsed: ReturnType<typeof parseInboundEvent>,
) {
  const next = pack.next_action;
  if (next === "stop_opted_out" || next === "already_closed") return;

  if (next === "ask_channel") {
    const hit = detectChannel(parsed.text);
    if (hit.mode === "cancel") {
      const copy = cancelCopy(pack.lead?.language ?? "ar");
      await sendAndLog(db, parsed.mobile, copy, { kind: "cancel_ack" }, "channel");
      return;
    }
    if (hit.mode === "set_choice") {
      const { data: fresh, error: choiceErr } = await db.rpc("set_channel_choice", {
        p_mobile: parsed.mobile,
        p_choice: hit.choice,
        p_preferred_call_at: null,
      });
      if (choiceErr) {
        console.error("set_channel_choice", choiceErr);
        return;
      }
      const after = (fresh ?? pack) as Pack & { call_window?: string; dial_now?: boolean };
      const ar = (after.lead?.language ?? pack.lead?.language ?? "ar") === "ar";
      const vehicle = vehicleLabel(
        readVehicle(after),
        ar,
      );
      const copy = confirmCopy({
        choice: hit.choice,
        language: after.lead?.language ?? pack.lead?.language ?? "ar",
        vehicle,
        windowOpen: after.call_window === "open",
      });
      await sendAndLog(db, parsed.mobile, copy, { kind: `channel_${hit.choice}` }, "channel");
      if (after.dial_now) {
        const dial = await placeCall(after, after as Record<string, unknown>);
        await db.from("messages").insert({
          lead_id: after.lead?.id,
          channel: "whatsapp",
          direction: "system",
          text: dial,
          handler: "inbound",
          meta: { kind: "dial", path: "keyword" },
        });
      }
      return;
    }
  }

  const mode = next === "ask_channel" ? "ask_channel" : "gather";
  const turn = await runBrainTurn(db, pack, parsed.text, mode);
  await db.from("messages").insert({
    lead_id: pack.lead?.id,
    channel: "whatsapp",
    direction: "system",
    text: `brain ${mode}: applied [${turn.applied.join(", ")}]` +
      (turn.rejected.length ? ` rejected [${turn.rejected.map((r) => `${r.action.type}: ${r.reason}`).join("; ")}]` : "") +
      (turn.model_error ? ` error [${turn.model_error}]` : ""),
    lang: pack.lead?.language ?? null,
    step: pack.lead?.current_step ?? null,
    handler: "inbound",
    meta: {
      kind: "brain_audit",
      mode,
      proposed: turn.proposed,
      floor: turn.floor,
      applied: turn.applied,
      rejected: turn.rejected,
      fallback: turn.fallback,
      provider: turn.provider,
      model_ms: turn.model_ms,
      total_ms: turn.total_ms,
      model_error: turn.model_error,
    },
  });
  if (turn.closing) {
    const sent = await sendTemplate({
      to: parsed.mobile,
      name: turn.closing.name,
      language: turn.closing.language,
      params: turn.closing.params,
    });
    if (!sent.ok) {
      console.error("closing template failed", sent.status, sent.text.slice(0, 200));
      await sendAndLog(db, parsed.mobile, turn.reply, {
        kind: "brain_gather",
        template_name: turn.closing.name,
        template_error: sent.text.slice(0, 300),
      });
      return;
    }
    await db.rpc("record_outbound", {
      p_mobile: parsed.mobile,
      p_text: turn.reply,
      p_channel: "whatsapp",
      p_step: null,
      p_handler: "inbound",
      p_meta: {
        kind: "closing_template",
        template_name: turn.closing.name,
        language: turn.closing.language,
        send_ok: true,
        send_status: sent.status,
      },
    });
    return;
  }
  if (turn.reply) {
    await sendAndLog(db, parsed.mobile, turn.reply, { kind: mode === "ask_channel" ? "brain_ask" : "brain_gather" });
  }
}

async function acceptMessage(db: ReturnType<typeof createClient>, evt: Record<string, unknown>) {
  const parsed = parseInboundEvent(evt);
  if (!parsed.mobile) return;
  if (await alreadySeen(db, parsed.eventId)) return;

  const { data, error } = await db.rpc("record_inbound", {
    p_mobile: parsed.mobile,
    p_text: parsed.text,
    p_channel: "whatsapp",
    p_meta: {
      event_id: parsed.eventId,
      message_id: parsed.messageId,
      message_type: parsed.messageType,
      window_state: evt.windowState ?? null,
    },
  });
  if (error || !data) {
    console.error("record_inbound", error);
    return;
  }
  await finish(continueTurn(db, data as Pack, parsed).catch((err) => console.error("inbound turn", err)));
}

function readVehicle(pack: Pack): string {
  return String(pack.selection?.vehicle ?? pack.lead?.selection?.vehicle ?? pack.latest_submission?.vehicle ?? "");
}

async function handleOptOut(db: ReturnType<typeof createClient>, evt: Record<string, unknown>) {
  const mobile = parseInboundEvent(evt).mobile;
  if (!mobile) return;
  await db.from("leads").update({ opted_out: true }).eq("mobile_e164", mobile);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const raw = await req.text();
  const secret = Deno.env.get("CHANNEL_WEBHOOK_SECRET") ?? "";
  if (!secret) return json(503, { error: "CHANNEL_WEBHOOK_SECRET missing" });
  const ok = await verifySignature(raw, req.headers.get("x-webhook-signature") ?? "", secret);
  if (!ok) return json(401, { error: "bad signature" });

  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(raw);
  } catch {
    return json(400, { error: "bad json" });
  }

  if (evt.channelId && String(evt.channelId) !== CHANNEL_ID) {
    return json(200, { ignored: "other channel" });
  }

  const eventType = String(evt.eventType ?? "");
  if (eventType !== "message.received" && eventType !== "contact.opted_out") {
    return json(200, { ignored: eventType || "unknown" });
  }

  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey());
  if (eventType === "contact.opted_out") {
    await handleOptOut(db, evt);
    return json(200, { ok: true });
  }
  await acceptMessage(db, evt);
  return json(200, { ok: true });
});
