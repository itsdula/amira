import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { findGrade, findModel } from "./catalogue.ts";
import { guessGender } from "./gender.ts";
import { CHAT_ASSISTANT_ID, CHANNEL_ID, AF_BASE, placeCall, vehicleLabel } from "./af.ts";
import {
  Action,
  BrainOutput,
  Pack,
  Rejection,
  answerOnly,
  floorPatchFromText,
  isConfirm,
  isQuestion,
  leadTemperature,
  nextAsk,
  readSelection,
  replyCompromised,
  sayLease,
  stripEmoji,
  validateActions,
  wantsCall,
} from "./brain-contract.ts";
// OpenAI fallback only. The live path is the WhatsApp Assistant system prompt
// (ASSISTANT_PROMPT.md). This function does not repeat those instructions.
const FALLBACK_SYSTEM = `You are Amira, a Riyadh showroom advisor for Changan on WhatsApp. Warm and unhurried.

The user message is facts, then the conversation. If language is ar, reply in colloquial Najdi. If en, plain English. If they write Arabizi, understand it as Arabic and answer in Najdi. Never write Arabizi yourself.

Learn, in whatever order feels natural: their name, whether to continue on WhatsApp or by a call, the vehicle, the grade, payment (cash, finance, or lease-to-own), color, whether to raise the order now, and accessories (or none). When the empty field is timing, ask متى ناوي تأخذ السيارة؟ Soon is timing now. A month or more is over_month. One question per message. If they asked you something, answer it and stop. Do not add the next field in that same message. In Arabic the payment choices are كاش، تمويل، and تأجير منتهي بالتمليك. Never say تأجير on its own. If gender_form is unknown and the name tells you, add set_gender m or f. If you cannot tell, leave it. Never ask. The name fact is the first name. Address them by that only. Never ask for a phone number. Never invent a price, a grade, or a color. Never use an emoji. The brand is شانجان.

Respond with ONLY this JSON:
{"reply":"the WhatsApp message","actions":[]}

reply is always required. actions is what you learned this turn, or an empty array. Action types: set_name, set_channel (whatsapp|call_now|schedule), opt_out, patch_selection.`;

function catalogueSlice(pack: Pack): string {
  const sel = readSelection(pack);
  const vehicle = sel.vehicle ?? pack.latest_submission?.vehicle;
  const model = findModel(String(vehicle ?? ""));
  if (!model) {
    return "No vehicle chosen yet. Catalogue models: " +
      "ALSVIN, CS 35 Plus, CS 75 Plus, CS 95, EADO Plus, Hunter, UNI-K, UNI S, UNI-T, UNI V.";
  }
  const colors = [...new Set(model.grades.flatMap((g) => g.colours))];
  const grades = model.grades.map((g) =>
    `${g.name_en ?? g.name_ar} (${g.name_ar}): ${g.price_incl_vat_sar} SAR incl. VAT`
  ).join("\n");
  return `Vehicle on file: ${model.name} (${model.id}).\n${grades}\n` +
    `Colors: ${colors.join(", ")}\n` +
    "Showroom extras (tint, PPF, nano) have NO published price - never invent one.";
}

export function dynamicContext(pack: Pack, mode: "ask_channel" | "gather"): string {
  const lead = pack.lead ?? {};
  const sel = readSelection(pack);
  const ask = mode === "ask_channel" ? "channel" : nextAsk(sel);
  return [
    `language: ${lead.language ?? "ar"}`,
    `name: ${firstName(pack) || "unknown"}`,
    `gender_form: ${lead.gender_form ?? "unknown"}`,
    `channel: ${lead.current_channel ?? "unset"}`,
    `selection: ${JSON.stringify(sel)}`,
    `empty_field: ${ask}`,
    catalogueSlice(pack),
  ].join("\n");
}

function systemPrompt(pack: Pack, mode: "ask_channel" | "gather"): string {
  return [FALLBACK_SYSTEM, dynamicContext(pack, mode)].join("\n\n");
}

function transcript(pack: Pack & { recent_messages?: { direction: string; text: string }[] }, text: string): string {
  const recent = (pack.recent_messages ?? []).slice(0, 8).reverse()
    .map((m) => `${m.direction === "in" ? "Customer" : m.direction === "out" ? "Amira" : "System"}: ${m.text}`)
    .join("\n");
  return `${recent}\nCustomer: ${text}`;
}

export function fallbackReply(pack: Pack, mode: "ask_channel" | "gather"): string {
  const ar = (pack.lead?.language ?? "ar") === "ar";
  if (mode === "ask_channel") {
    return ar
      ? "تحب نكمل هنا بالواتساب، ولا نتصل عليك الحين، ولا نحدد لك موعد للاتصال؟"
      : "Would you like to continue here on WhatsApp, get a call now, or set a time for a call?";
  }
  const ask = nextAsk(readSelection(pack));
  if (ask === "color") return colorAsk(pack);
  if (ask === "grade") return gradeAsk(pack);
  const q: Record<string, [string, string]> = {
    vehicle: ["بس أتأكد، أي سيارة تبي نكمل عليها؟", "Just to confirm - which car should we continue with?"],
    payment: ["تحب تدفع كاش، ولا تمويل، ولا تأجير منتهي بالتمليك؟", "Would you pay cash, finance, or lease-to-own?"],
    order_now: ["تبينا نمشي لك بالطلب الحين؟", "Shall we raise the order for you now?"],
    accessories: ["تحب نضيف تظليل أو حماية للسيارة؟", "Would you like tint or protection added?"],
    purchase: ["تبي نكمل الشراء هنا بالشات، ولا تبي مندوب يتصل عليك؟", "Would you like to continue the purchase here in the chat, or get a call from a rep?"],
    rep_time: ["وش الوقت اللي يناسبك يتصل فيه المندوب؟ من ٩ الصبح إلى ٩ بالليل.", "What time works for the rep to call? We're available from 9am to 9pm."],
    timing: ["متى ناوي تأخذ السيارة؟", "When are you thinking of getting the car?"],
    close: ["أثبت الطلب؟", "Just confirm?"],
  };
  const pair = q[ask] ?? q.vehicle;
  return ar ? pair[0] : pair[1];
}

function extractJson(content: string): BrainOutput | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    if (typeof parsed?.reply !== "string" || !parsed.reply.trim()) return null;
    return { reply: parsed.reply, actions: Array.isArray(parsed.actions) ? parsed.actions : [] };
  } catch {
    return null;
  }
}

function readModel(content: string): BrainOutput | null {
  const json = extractJson(content);
  if (json) return json;
  const plain = content.replace(/```[\s\S]*?```/g, "").trim();
  if (!plain || plain.startsWith("{")) return null;
  return { reply: plain, actions: [] };
}

type ModelResult = { out: BrainOutput | null; ms: number; provider: string; error?: string };

async function callModelAF(context: string, user: string, mobile: string): Promise<ModelResult | null> {
  const afKey = Deno.env.get("AGENTICFLOW_API_KEY");
  const assistantId = Deno.env.get("BRAIN_AF_ASSISTANT_ID") || CHAT_ASSISTANT_ID;
  if (!afKey) return null;
  const t0 = performance.now();
  try {
    const res = await fetch(`${AF_BASE}/chat/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": afKey },
      body: JSON.stringify({
        channelId: CHANNEL_ID,
        threadKey: mobile,
        assistantId,
        content: `${context}\n\n${user}`,
      }),
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { out: null, ms, provider: "af", error: `af http ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    const content = data?.data?.message?.content ?? data?.message?.content ?? "";
    const out = readModel(String(content));
    return { out, ms, provider: "af", error: out ? undefined : "schema: empty assistant reply" };
  } catch (err) {
    return { out: null, ms: Math.round(performance.now() - t0), provider: "af", error: String(err).slice(0, 200) };
  }
}

async function callModelOpenAI(system: string, user: string): Promise<ModelResult> {
  const key = Deno.env.get("BRAIN_API_KEY");
  if (!key) {
    return { out: null, ms: 0, provider: "none", error: "no model configured (set BRAIN_AF_ASSISTANT_ID + AGENTICFLOW_API_KEY, or BRAIN_API_KEY)" };
  }
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
    const out = readModel(String(data?.choices?.[0]?.message?.content ?? ""));
    return { out, ms, provider: "openai", error: out ? undefined : "schema: reply missing" };
  } catch (err) {
    return { out: null, ms: Math.round(performance.now() - t0), provider: "openai", error: String(err).slice(0, 200) };
  }
}

async function callModel(system: string, context: string, user: string, mobile: string): Promise<ModelResult> {
  const af = await callModelAF(context, user, mobile);
  if (af) return af;
  return await callModelOpenAI(system, user);
}

async function execute(db: SupabaseClient, pack: Pack, accepted: Action[]): Promise<string[]> {
  const applied: string[] = [];
  const leadId = pack.lead?.id;
  const mobile = pack.lead?.mobile_e164 ?? null;
  if (!leadId) return applied;

  for (const action of accepted) {
    switch (action.type) {
      case "set_channel": {
        const { data, error } = await db.rpc("set_channel_choice", {
          p_mobile: mobile,
          p_choice: action.choice,
          p_preferred_call_at: action.preferred_call_at ?? null,
        });
        if (!error) applied.push(`set_channel:${action.choice}`);
        if (!error && action.choice === "call_now" && (data as { dial_now?: boolean })?.dial_now) {
          applied.push(await placeCall(pack, data as Record<string, unknown>));
        }
        break;
      }
      case "opt_out": {
        const { error } = await db.from("leads").update({ opted_out: true }).eq("id", leadId);
        if (!error) applied.push("opt_out");
        break;
      }
      case "set_gender": {
        const { error } = await db.from("leads")
          .update({ gender_form: action.gender_form })
          .eq("id", leadId);
        if (!error) applied.push(`set_gender:${action.gender_form}`);
        break;
      }
      case "set_name": {
        const fullName = String(action.full_name).trim();
        const gender = guessGender(fullName);
        const patch: { full_name: string; gender_form?: "m" | "f" } = { full_name: fullName };
        if (gender !== "unknown") patch.gender_form = gender;
        const { error } = await db.from("leads").update(patch).eq("id", leadId);
        if (!error) applied.push(`set_name:${gender}`);
        break;
      }
      case "patch_selection": {
        const { error } = await db.rpc("patch_selection", {
          p_lead_id: leadId,
          p_fields: action.fields,
        });
        if (!error) applied.push(`selection:${Object.keys(action.fields).join(",")}`);
        break;
      }
    }
  }
  return applied;
}

function speakColor(color: string): string {
  if (color === "ابيض") return "أبيض";
  if (color === "آخضر") return "أخضر";
  return color;
}

function arabicAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join("، ")}، و${items[items.length - 1]}`;
}

function gradeAsk(pack: Pack): string {
  const ar = (pack.lead?.language ?? "ar") === "ar";
  const name = firstName(pack);
  const sel = readSelection(pack);
  const model = findModel(String(sel.vehicle ?? ""));
  const grades = model?.grades ?? [];
  const bits = grades.map((g) => {
    const label = ar ? (g.name_ar || g.name_en || "") : (g.name_en || g.name_ar || "");
    const price = g.price_incl_vat_sar ? g.price_incl_vat_sar.toLocaleString("en-US") : "";
    return price ? `${label} ${price}` : label;
  });
  const list = ar ? arabicAnd(bits) : bits.join(", ");
  const vehicle = vehicleLabel(sel.vehicle ?? model?.name, ar);
  const caveat = ar ? "السعر مبدئي، والمستشار يأكده. " : "The price is preliminary, and the advisor confirms it. ";
  if (!list) return ar ? "أي فئة تناسبك؟" : "Which grade suits you?";
  return ar
    ? `تمام${name ? " يا " + name : ""}. ${caveat}فئات ${vehicle}: ${list}. أي فئة تناسبك؟`
    : `Alright${name ? " " + name : ""}. ${caveat}Grades for ${vehicle}: ${list}. Which grade suits you?`;
}

function colorAsk(pack: Pack): string {
  const ar = (pack.lead?.language ?? "ar") === "ar";
  const name = firstName(pack);
  const sel = readSelection(pack);
  const model = findModel(String(sel.vehicle ?? pack.latest_submission?.vehicle ?? ""));
  const grade = model && sel.grade ? findGrade(model, sel.grade) : null;
  const colors = (grade ? grade.colours : model ? [...new Set(model.grades.flatMap((g) => g.colours))] : []).map(speakColor);
  const vehicle = vehicleLabel(sel.vehicle ?? model?.name, ar);
  const list = ar ? arabicAnd(colors) : colors.join(", ");
  if (!list) return ar ? "وش اللون اللي يعجبك؟" : "Which color do you like?";
  return ar
    ? `تمام${name ? " يا " + name : ""}، المتوفر لـ ${vehicle}: ${list}. أي لون شدّك؟`
    : `Alright${name ? " " + name : ""}. Available for ${vehicle}: ${list}. Which color caught you?`;
}

function firstName(pack: Pack): string {
  return String(pack.lead?.full_name ?? "").trim().split(/\s+/)[0] ?? "";
}

function confirmAsk(pack: Pack): string {
  const ar = (pack.lead?.language ?? "ar") === "ar";
  const name = firstName(pack);
  return ar
    ? `${name ? name + "، " : ""}أثبت الطلب؟`
    : `${name ? name + ", " : ""}Just confirm?`;
}

function scheduleReply(pack: Pack): string {
  const ar = (pack.lead?.language ?? "ar") === "ar";
  const name = firstName(pack);
  return ar
    ? `أبشر${name ? " " + name : ""}. مندوب بيتصل عليك على هذا الرقم.`
    : `Sure${name ? " " + name : ""}. A rep will call you on this number.`;
}

function closingSummary(pack: Pack, temp: "hot" | "cold"): string {
  const ar = (pack.lead?.language ?? "ar") === "ar";
  const sel = readSelection(pack);
  const name = firstName(pack);
  const vehicle = vehicleLabel(sel.vehicle, ar);
  const pay = sel.payment === "finance" ? (ar ? "تمويل" : "finance")
    : sel.payment === "lease" ? (ar ? "تأجير منتهي بالتمليك" : "lease-to-own")
    : (ar ? "كاش" : "cash");
  const color = sel.color ?? (ar ? "بدون لون محدد" : "no color yet");
  const extras = sel.accessories === "none" || !sel.accessories
    ? (ar ? "بدون إضافات" : "no extras")
    : (Array.isArray(sel.accessories) ? sel.accessories.join(", ") : String(sel.accessories));
  const when = sel.timing === "over_month"
    ? (ar ? "بعد شهر أو أكثر" : "in a month or more")
    : (ar ? "الحين" : "now");
  const mobile = pack.lead?.mobile_e164 ?? "";
  const buy = sel.purchase === "online"
    ? (ar ? "نكمل الشراء هنا بالشات" : "continue the purchase in the chat")
    : sel.purchase === "telesales"
    ? (ar ? `مندوب بيتصل عليك${sel.rep_time ? " " + sel.rep_time : ""}` : `a rep will call you${sel.rep_time ? " " + sel.rep_time : ""}`)
    : "";
  const order = ar
    ? `${vehicle}، ${pay}، ${color}، ${extras}`
    : `${vehicle}, ${pay}, ${color}, ${extras}`;
  if (temp === "cold") {
    return ar
      ? `شكراً${name ? " " + name : ""}. طلبك: ${order}. بنتواصل معك لما يكون الوقت أنسب: ${when}.`
      : `Thank you${name ? " " + name : ""}. Your order: ${order}. We'll be in touch when the time is better: ${when}.`;
  }
  const call = mobile
    ? (ar ? ` طلب الاتصال على ${mobile}.` : ` Callback on ${mobile}.`)
    : "";
  if (buy) {
    return ar
      ? `تم${name ? " " + name : ""}. طلبك: ${order}. ${buy}.${call}`
      : `Confirmed${name ? " " + name : ""}. Your order: ${order}. ${buy}.${call}`;
  }
  return ar
    ? `تم${name ? " " + name : ""}. طلبك: ${order}. بيتواصل معك أحد من الفريق حسب الوقت اللي حددته: ${when}.`
    : `Confirmed${name ? " " + name : ""}. Your order: ${order}. A company rep will get in touch based on the time you asked for: ${when}.`;
}

export type ClosingTemplate = { name: string; language: string; params: string[] };

function templateParam(text: string, fallback: string): string {
  const clean = String(text ?? "").replace(/[\n\r\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return clean || fallback;
}

export function closingTemplate(pack: Pack, temp: "hot" | "cold"): ClosingTemplate {
  const ar = (pack.lead?.language ?? "ar") === "ar";
  const sel = readSelection(pack);
  const missing = ar ? "غير محدد" : "not specified";
  const model = findModel(String(sel.vehicle ?? ""));
  const gradeRow = model && sel.grade ? findGrade(model, sel.grade) : null;
  const gradeLabel = gradeRow ? (ar ? (gradeRow.name_ar || gradeRow.name_en || missing) : (gradeRow.name_en || missing)) : missing;
  const price = gradeRow?.price_incl_vat_sar
    ? (ar ? `${gradeRow.price_incl_vat_sar.toLocaleString("en-US")} ريال` : `SAR ${gradeRow.price_incl_vat_sar.toLocaleString("en-US")}`)
    : missing;
  const name = firstName(pack) || (ar ? "عميلنا" : "there");
  const vehicle = vehicleLabel(sel.vehicle, ar);
  const pay = sel.payment === "finance" ? (ar ? "تمويل" : "finance")
    : sel.payment === "lease" ? (ar ? "تأجير منتهي بالتمليك" : "lease-to-own")
    : (ar ? "كاش" : "cash");
  const color = sel.color ?? missing;
  const extras = sel.accessories === "none" || !sel.accessories
    ? (ar ? "بدون إضافات" : "no extras")
    : (Array.isArray(sel.accessories) ? sel.accessories.join(", ") : String(sel.accessories));
  const when = sel.timing === "over_month"
    ? (ar ? "بعد شهر أو أكثر" : "in a month or more")
    : (ar ? "الحين" : "now");
  const mobile = pack.lead?.mobile_e164 ?? "";
  const buy = sel.purchase === "online"
    ? (ar ? "نكمل الشراء هنا بالشات" : "continue the purchase in the chat")
    : sel.purchase === "telesales"
    ? (ar ? `مندوب بيتصل عليك${sel.rep_time ? " " + sel.rep_time : ""}` : `a rep will call you${sel.rep_time ? " " + sel.rep_time : ""}`)
    : "";
  const next = temp === "cold"
    ? (ar ? `بنتواصل معك لما يكون الوقت أنسب: ${when}` : `We'll be in touch when the time is better: ${when}`)
    : buy
    ? `${buy}${mobile ? (ar ? ` على ${mobile}` : ` on ${mobile}`) : ""}`
    : (ar ? `بيتواصل معك أحد من الفريق: ${when}` : `A company rep will be in touch: ${when}`);
  return {
    name: ar ? "closing_summary_ar" : "closing_summary_en",
    language: ar ? "ar" : "en_US",
    params: [name, vehicle, gradeLabel, price, color, pay, extras, next].map((part) => templateParam(part, missing)),
  };
}

export type BrainTurnResult = {
  reply: string;
  applied: string[];
  rejected: Rejection[];
  fallback: boolean;
  provider: string;
  model_ms: number;
  total_ms: number;
  model_error: string | null;
  proposed: Action[];
  floor: ReturnType<typeof floorPatchFromText>;
  closing: ClosingTemplate | null;
};

async function fillKnownGender(db: SupabaseClient, pack: Pack): Promise<void> {
  const lead = pack.lead;
  if (!lead?.id || lead.gender_form === "m" || lead.gender_form === "f") return;
  const gender = guessGender(lead.full_name);
  if (gender === "unknown") return;
  const { error } = await db.from("leads").update({ gender_form: gender }).eq("id", lead.id);
  if (!error) lead.gender_form = gender;
}

export async function runBrainTurn(
  db: SupabaseClient,
  pack: Pack,
  text: string,
  mode: "ask_channel" | "gather",
): Promise<BrainTurnResult> {
  const t0 = performance.now();
  await fillKnownGender(db, pack);
  const system = systemPrompt(pack, mode);
  const context = dynamicContext(pack, mode);
  const convo = transcript(pack as Parameters<typeof transcript>[0], text);
  const mobile = pack.lead?.mobile_e164 ?? "";
  let attempt = await callModel(system, context, convo, mobile);
  if (!attempt.out && !attempt.error?.startsWith("no model configured")) {
    attempt = await callModel(system, context, convo, mobile);
  }

  const proposed = attempt.out?.actions ?? [];
  const floor = floorPatchFromText(pack, text);
  const merged: Action[] = [...proposed];
  if (floor) merged.push({ type: "patch_selection", fields: floor });
  const asked = nextAsk(readSelection(pack));
  if (asked === "timing" && wantsCall(text)) {
    if (!merged.some((a) => a.type === "set_channel")) {
      merged.push({ type: "set_channel", choice: "schedule" });
    }
    if (!floor) merged.push({ type: "patch_selection", fields: { timing: "now" } });
  } else if (
    asked === "timing" && !floor && !isQuestion(text) && text.trim() && !/^(لا|لأ|no)$/i.test(text.trim())
  ) {
    merged.push({ type: "patch_selection", fields: { timing: "now" } });
  }

  const verdict = validateActions(pack, merged);
  const applied = await execute(db, pack, verdict.accepted);

  let selAfter = readSelection(pack);
  for (const action of verdict.accepted) {
    if (action.type === "patch_selection") selAfter = { ...selAfter, ...action.fields };
  }
  const packAfter: Pack = {
    ...pack,
    selection: selAfter,
    lead: { ...pack.lead, selection: selAfter },
  };

  let reply: string;
  let fallback = false;
  if (attempt.out && !replyCompromised(verdict.rejected)) {
    reply = attempt.out.reply;
  } else {
    reply = fallbackReply(packAfter, mode);
    fallback = true;
  }

  const dialed = applied.some((item) => item.startsWith("dial:"));
  const askedCall = verdict.accepted.some((a) => a.type === "set_channel" && a.choice === "call_now");
  const scheduled = verdict.accepted.some((a) => a.type === "set_channel" && a.choice === "schedule");
  const closed = pack.lead?.status === "hot" || pack.lead?.status === "cold";
  let scripted = false;
  let closing: ClosingTemplate | null = null;
  const purchaseClose = (asked === "purchase" && selAfter.purchase === "online")
    || (asked === "rep_time" && Boolean(selAfter.rep_time));
  if (nextAsk(selAfter) === "rep_time" && !isQuestion(text)) {
    reply = fallbackReply(packAfter, "gather");
    fallback = false;
    scripted = true;
  } else if (dialed) {
    const ar = (pack.lead?.language ?? "ar") === "ar";
    const name = firstName(packAfter);
    reply = ar
      ? `أبشر${name ? " " + name : ""}، بنتصل عليك الحين على هالرقم.`
      : `Sure${name ? " " + name : ""}, calling you now on this number.`;
    fallback = false;
    scripted = true;
  } else if (askedCall) {
    const ar = (pack.lead?.language ?? "ar") === "ar";
    reply = ar
      ? "أبشر، بس الحين برا أوقات الاتصال. بنتصل عليك الساعة ٩ الصبح."
      : "Sure. We're outside calling hours. We'll call you at 9am.";
    fallback = false;
    scripted = true;
  } else if (!purchaseClose && (scheduled || (asked === "close" && pack.lead?.status === "scheduled"))) {
    reply = scheduleReply(packAfter);
    fallback = false;
    scripted = true;
  } else if (!closed && nextAsk(selAfter) === "close" && pack.lead?.id) {
    const temp = leadTemperature(selAfter);
    if (temp === "cold" || purchaseClose || (asked === "close" && isConfirm(text))) {
      const { error } = await db.from("leads").update({ status: temp }).eq("id", pack.lead.id);
      if (!error) applied.push(`status:${temp}`);
      reply = closingSummary(packAfter, temp);
      if (!error) closing = closingTemplate(packAfter, temp);
      fallback = false;
    } else {
      reply = confirmAsk(packAfter);
      fallback = false;
    }
    scripted = true;
  } else if (nextAsk(selAfter) === "grade" && !isQuestion(text)) {
    reply = gradeAsk(packAfter);
    fallback = false;
    scripted = true;
  } else if (nextAsk(selAfter) === "color" && !isQuestion(text)) {
    reply = colorAsk(packAfter);
    fallback = false;
    scripted = true;
  } else if (
    (nextAsk(selAfter) === "accessories" || nextAsk(selAfter) === "purchase" || nextAsk(selAfter) === "rep_time" || nextAsk(selAfter) === "timing") &&
    !isQuestion(text)
  ) {
    reply = fallbackReply(packAfter, "gather");
    fallback = false;
    scripted = true;
  }
  if (!scripted && !fallback && isQuestion(text)) reply = answerOnly(reply);
  reply = sayLease(stripEmoji(reply));

  return {
    reply,
    applied,
    rejected: verdict.rejected,
    fallback,
    provider: attempt.provider,
    model_ms: attempt.ms,
    total_ms: Math.round(performance.now() - t0),
    model_error: attempt.error ?? null,
    proposed,
    floor,
    closing,
  };
}
