// inbound-brain — model turn only. Live WhatsApp traffic goes through `inbound`.
// POST { pack, text, message_id } → { reply, applied, rejected, mode, fallback, latency }
// Kept for curls / debugging. Auth: service-role key header.

import { createClient } from "npm:@supabase/supabase-js@2";
import { runBrainTurn } from "../_shared/brain-turn.ts";
import { nextAsk, readSelection, type Pack } from "../_shared/brain-contract.ts";
import { serviceKey } from "../_shared/env.ts";

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
    } catch (_) { /* ignore */ }
  }
  return keys;
}

const keyVerdicts = new Map<string, boolean>();

async function isPrivileged(k: string): Promise<boolean> {
  if (!k) return false;
  if (envKeys().has(k)) return true;
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const apikey = req.headers.get("apikey") ?? "";
  if (!(await isPrivileged(apikey)) && !(await isPrivileged(bearer))) {
    return json(401, { error: "unauthorized" });
  }

  let body: { pack?: Pack; text?: string };
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
  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey());
  const turn = await runBrainTurn(db, pack, text, mode);

  await db.from("messages").insert({
    lead_id: pack.lead.id,
    channel: "whatsapp",
    direction: "system",
    text: `brain ${mode}: applied [${turn.applied.join(", ")}]` +
      (turn.rejected.length ? ` rejected [${turn.rejected.map((r) => `${r.action.type}: ${r.reason}`).join("; ")}]` : "") +
      (turn.model_error ? ` error [${turn.model_error}]` : ""),
    lang: pack.lead.language ?? null,
    step: pack.lead.current_step ?? nextAsk(readSelection(pack)),
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

  return json(200, {
    reply: turn.reply,
    applied: turn.applied,
    rejected: turn.rejected,
    mode,
    fallback: turn.fallback,
    latency: { model_ms: turn.model_ms, total_ms: turn.total_ms },
  });
});
