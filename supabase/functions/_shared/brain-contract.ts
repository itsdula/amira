// inbound-brain action contract: the LLM proposes, this file decides.
// Pure functions of (pack, actions) — no model, no network.

import { findGrade, findModel, MODELS } from "./catalogue.ts";

export type Selection = {
  vehicle: string | null;
  grade: string | null;
  payment: "cash" | "finance" | "lease" | null;
  color: string | null;
  order_now: boolean | "none" | null;
  accessories: string[] | "none" | null;
  purchase: "online" | "telesales" | "none" | null;
  rep_time: string | "none" | null;
  timing: "now" | "over_month" | "none" | null;
};

export const EMPTY_SELECTION: Selection = {
  vehicle: null,
  grade: null,
  payment: null,
  color: null,
  order_now: null,
  accessories: null,
  purchase: null,
  rep_time: null,
  timing: null,
};

export const SELECTION_KEYS = [
  "vehicle",
  "grade",
  "payment",
  "color",
  "order_now",
  "accessories",
  "purchase",
  "rep_time",
  "timing",
] as const;

export type SelectionKey = (typeof SELECTION_KEYS)[number];

export type AskField = SelectionKey | "close";

export type Action =
  | { type: "set_channel"; choice: "whatsapp" | "call_now" | "schedule"; preferred_call_at?: string | null }
  | { type: "opt_out" }
  | { type: "set_name"; full_name: string }
  | { type: "set_gender"; gender_form: "m" | "f" }
  | { type: "patch_selection"; fields: Partial<Selection> }
  // Legacy shapes still emitted by an unpatched assistant — folded in normalizeActions.
  | { type: "upsert_fact"; key: string; value: unknown; declined?: boolean }
  | { type: "update_step_context"; narrative?: string; open_threads?: string[] }
  | { type: "advance_step"; step: string };

export type BrainOutput = { reply: string; actions: Action[] };

export type Rejection = { action: Action; reason: string };

export type Pack = {
  lead?: {
    id?: string;
    mobile_e164?: string;
    language?: string;
    current_step?: string;
    current_channel?: string;
    opted_out?: boolean;
    status?: string;
    full_name?: string | null;
    gender_form?: string;
    selection?: Selection | null;
  };
  selection?: Selection | null;
  next_ask?: string;
  latest_submission?: { vehicle?: string | null };
  next_action?: string;
};

const PAYMENTS = new Set(["cash", "finance", "lease"]);
const TIMINGS = new Set(["now", "over_month"]);
const FORBIDDEN_KEYS = new Set([
  "phone", "mobile", "mobile_e164", "number", "رقم", "phone_number", "phoneNumber",
]);

export function readSelection(pack: Pack): Selection {
  const raw = pack.lead?.selection ?? pack.selection ?? EMPTY_SELECTION;
  return { ...EMPTY_SELECTION, ...raw };
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined;
}

export function nextAsk(sel: Selection): AskField {
  if (isEmpty(sel.vehicle)) return "vehicle";
  if (isEmpty(sel.grade)) return "grade";
  if (isEmpty(sel.payment)) return "payment";
  if (isEmpty(sel.color)) return "color";
  if (isEmpty(sel.order_now)) return "order_now";
  if (sel.order_now === true && isEmpty(sel.accessories)) return "accessories";
  if (sel.order_now === true && isEmpty(sel.purchase)) return "purchase";
  if (sel.purchase === "telesales" && isEmpty(sel.rep_time)) return "rep_time";
  if (isEmpty(sel.timing) && !(sel.order_now === true && sel.purchase)) return "timing";
  return "close";
}

export function uncoveredKeys(sel: Selection): SelectionKey[] {
  const keys: SelectionKey[] = [];
  if (isEmpty(sel.vehicle)) keys.push("vehicle");
  if (isEmpty(sel.grade)) keys.push("grade");
  if (isEmpty(sel.payment)) keys.push("payment");
  if (isEmpty(sel.color)) keys.push("color");
  if (isEmpty(sel.order_now)) keys.push("order_now");
  if (sel.order_now === true && isEmpty(sel.accessories)) keys.push("accessories");
  if (sel.order_now === true && isEmpty(sel.purchase)) keys.push("purchase");
  if (sel.purchase === "telesales" && isEmpty(sel.rep_time)) keys.push("rep_time");
  if (isEmpty(sel.timing) && !(sel.order_now === true && sel.purchase)) keys.push("timing");
  return keys;
}

function foldAr(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\s+/g, "");
}

const COLOR_EN: Record<string, string> = {
  red: "أحمر",
  white: "ابيض",
  black: "أسود",
  grey: "رمادي",
  gray: "رمادي",
  blue: "أزرق",
  green: "أخضر",
  silver: "فضي",
  gold: "ذهبي",
};

export function findColor(vehicleIdOrName: string, raw: string, gradeName?: string | null): string | null {
  const model = findModel(vehicleIdOrName);
  if (!model || !raw) return null;
  const grade = gradeName ? findGrade(model, gradeName) : null;
  const known = grade ? grade.colours : [...new Set(model.grades.flatMap((g) => g.colours))];
  const q = foldAr(raw);
  const direct = known.find((c) => foldAr(c) === q);
  if (direct) return direct;
  const mapped = COLOR_EN[String(raw).trim().toLowerCase()];
  if (mapped) {
    const hit = known.find((c) => foldAr(c) === foldAr(mapped));
    if (hit) return hit;
  }
  return null;
}

function extractGradeName(vehicleId: string, text: string): string | null {
  const model = findModel(vehicleId);
  if (!model) return null;
  const direct = findGrade(model, text.trim());
  if (direct?.name_en) return direct.name_en;
  const folded = foldAr(text);
  const hit = model.grades.find((g) => {
    const en = foldAr(g.name_en ?? "");
    const ar = foldAr(g.name_ar ?? "");
    return (en.length > 1 && folded.includes(en)) || (ar.length > 1 && folded.includes(ar));
  });
  return hit?.name_en ?? null;
}

function isSkip(text: string): boolean {
  const f = foldAr(text);
  return /(مايهم|مو مهم|skip|none|بدونتفضيل|ماابي اجاوب|ماابغى اجاوب)/.test(f);
}

function extractVehicleId(text: string): string | null {
  const direct = findModel(text);
  if (direct) return direct.id;
  const lower = String(text ?? "").toLowerCase();
  const hits = MODELS
    .filter((m) => lower.includes(m.name.toLowerCase()) || lower.includes(m.id.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length);
  return hits[0]?.id ?? null;
}

function extractPayment(text: string): Selection["payment"] | undefined {
  const f = foldAr(text);
  if (/(كاش|نقد|cash)/.test(f)) return "cash";
  if (/(تمويل|تقسيط|finance)/.test(f)) return "finance";
  if (/(تاجيرمنتهيبالتمليك|ايجارمنتهيبالتمليك|lease)/.test(f)) return "lease";
  return undefined;
}

function extractOrderNow(text: string): boolean | undefined {
  const f = foldAr(text);
  if (/(يااليت|ارفع|نرفع|نعم|ايوه|ايوة|ايه|يب|yes|yeah|yep|موافق)/.test(f)) return true;
  if (/^(لا|لاا|لأ|no)$/.test(f)) return false;
  if (/(ماابي|موالحين|بعدين)/.test(f) && !/(يااليت|ارفع|نرفع)/.test(f)) return false;
  return undefined;
}

function extractAccessories(text: string): string[] | "none" | undefined {
  const f = foldAr(text);
  if (/(بدون|نكتفي|ماابي|none|لااكسسوار)/.test(f)) return "none";
  if (/^(لا|لاا|لأ|no)$/.test(f)) return "none";
  const names: string[] = [];
  if (/(تظليل|tint)/.test(f)) names.push("tint");
  if (/(ppf|nano|حمايه)/.test(f)) names.push("protection");
  return names.length > 0 ? names : undefined;
}

function extractPurchase(text: string): Selection["purchase"] | undefined {
  const f = foldAr(text);
  if (/(شات|واتس|اونلاين|online|chat|here)/.test(f) || /هنا/.test(String(text ?? ""))) return "online";
  if (/(اتصال|يتصل|مكالم|مندوب|مبيعات|تليسيلز|telesales|\bcall\b|\brep\b)/.test(f) || /\b(call|rep)\b/i.test(text)) return "telesales";
  return undefined;
}

function extractTiming(text: string): Selection["timing"] | undefined {
  const f = foldAr(text);
  if (/(بعدشهر|اكثرمنشهر|موستعجل|over_month|later)/.test(f)) return "over_month";
  if (/(الحين|الان|now|today|هالاسبوع|هذاالاسبوع)/.test(f)) return "now";
  return undefined;
}

/** Code floor: write NEXT ASK when the inbound text is a clear catalogue/enum answer. */
export function floorPatchFromText(pack: Pack, text: string): Partial<Selection> | null {
  const sel = readSelection(pack);
  const ask = nextAsk(sel);
  const raw = String(text ?? "").trim();
  if (!raw || ask === "close") return null;

  let value: unknown;
  switch (ask) {
    case "vehicle":
      value = extractVehicleId(raw);
      break;
    case "grade":
      value = sel.vehicle ? extractGradeName(sel.vehicle, raw) : null;
      break;
    case "payment":
      value = extractPayment(raw);
      break;
    case "color":
      value = sel.vehicle ? findColor(sel.vehicle, raw, sel.grade) : null;
      break;
    case "order_now":
      value = extractOrderNow(raw);
      break;
    case "accessories":
      value = extractAccessories(raw);
      break;
    case "purchase":
      value = extractPurchase(raw);
      break;
    case "rep_time":
      value = raw;
      break;
    case "timing":
      value = extractTiming(raw);
      break;
  }
  if (value === undefined || value === null) {
    if (isSkip(raw) && (ask === "order_now" || ask === "purchase" || ask === "rep_time" || ask === "timing")) {
      return { [ask]: "none" } as Partial<Selection>;
    }
    return null;
  }
  if (ask === "purchase" && value === "online") {
    return { purchase: "online", timing: sel.timing ?? "now" };
  }
  if (ask === "purchase") return { purchase: value as Selection["purchase"] };
  if (ask === "rep_time") return { rep_time: String(value), timing: sel.timing ?? "now" };
  return { [ask]: value } as Partial<Selection>;
}

function asAccessories(value: unknown): string[] | "none" | null {
  if (value === null || value === undefined) return null;
  if (value === "none" || value === "no" || value === false) return "none";
  if (Array.isArray(value)) {
    const names = value.map((v) => String(v).trim()).filter(Boolean);
    return names.length === 0 ? "none" : names;
  }
  const s = String(value).trim().toLowerCase();
  if (!s || s === "none" || s === "no") return "none";
  return [String(value).trim()];
}

export function normalizeSelectionValue(
  current: Selection,
  key: SelectionKey,
  value: unknown,
): { ok: true; value: Selection[SelectionKey] } | { ok: false; reason: string } {
  switch (key) {
    case "vehicle": {
      const model = findModel(String(value ?? ""));
      if (!model) return { ok: false, reason: `vehicle ${JSON.stringify(value)} is not in the catalogue` };
      return { ok: true, value: model.id };
    }
    case "grade": {
      const model = current.vehicle ? findModel(current.vehicle) : null;
      if (!model) return { ok: false, reason: "grade requires a known vehicle first" };
      const grade = findGrade(model, String(value ?? ""));
      if (!grade?.name_en) return { ok: false, reason: `grade ${JSON.stringify(value)} is not in the catalogue for ${model.id}` };
      return { ok: true, value: grade.name_en };
    }
    case "payment": {
      let v = String(value ?? "").trim().toLowerCase();
      if (v === "financing" || v === "finance") v = "finance";
      if (v === "cash") v = "cash";
      if (v === "lease" || v === "leasing") v = "lease";
      if (!PAYMENTS.has(v)) return { ok: false, reason: `payment must be cash | finance | lease, got ${JSON.stringify(value)}` };
      return { ok: true, value: v as Selection["payment"] };
    }
    case "color": {
      const vehicle = current.vehicle;
      if (!vehicle) return { ok: false, reason: "color requires a known vehicle first" };
      const canonical = findColor(vehicle, String(value ?? ""), current.grade);
      if (!canonical) return { ok: false, reason: `color ${JSON.stringify(value)} is not in the catalogue for ${vehicle}` };
      return { ok: true, value: canonical };
    }
    case "order_now":
      if (value === "none") return { ok: true, value: "none" };
      if (typeof value !== "boolean") return { ok: false, reason: "order_now must be boolean or \"none\"" };
      return { ok: true, value };
    case "accessories": {
      const acc = asAccessories(value);
      if (acc === null) return { ok: false, reason: "accessories must be an array of names or \"none\"" };
      return { ok: true, value: acc };
    }
    case "purchase": {
      const v = String(value ?? "").trim().toLowerCase();
      if (v !== "online" && v !== "telesales" && v !== "none") {
        return { ok: false, reason: `purchase must be online | telesales | none, got ${JSON.stringify(value)}` };
      }
      return { ok: true, value: v as Selection["purchase"] };
    }
    case "rep_time": {
      const v = String(value ?? "").trim();
      if (!v) return { ok: false, reason: "rep_time is empty" };
      if (v.toLowerCase() === "none") return { ok: true, value: "none" };
      return { ok: true, value: v };
    }
    case "timing": {
      const v = String(value ?? "").trim().toLowerCase();
      const mapped = v === "now" || v === "today" || v === "immediately" ? "now"
        : v === "over_month" || v === "later" || v === "month" ? "over_month"
        : v === "none" ? "none"
        : v;
      if (mapped !== "now" && mapped !== "over_month" && mapped !== "none") {
        return { ok: false, reason: `timing must be now | over_month | none, got ${JSON.stringify(value)}` };
      }
      return { ok: true, value: mapped as Selection["timing"] };
    }
  }
}

export function applySelectionPatch(
  current: Selection,
  fields: Record<string, unknown>,
): { next: Selection; accepted: Partial<Selection>; rejected: { key: string; reason: string }[] } {
  const next: Selection = { ...current };
  const accepted: Partial<Selection> = {};
  const rejected: { key: string; reason: string }[] = [];

  for (const key of Object.keys(fields)) {
    if (FORBIDDEN_KEYS.has(key) || /phone|mobile|رقم/.test(key)) {
      rejected.push({ key, reason: "never store a phone number; it is already on the lead" });
    }
  }

  const order: SelectionKey[] = ["vehicle", "grade", "payment", "color", "order_now", "accessories", "purchase", "rep_time", "timing"];
  for (const key of order) {
    if (!(key in fields)) continue;
    const raw = fields[key];
    if (raw === undefined) continue;
    if (key === "accessories" && next.order_now === false) {
      next.accessories = "none";
      accepted.accessories = "none";
      continue;
    }
    if (key === "accessories" && next.order_now !== true && fields.order_now !== true) {
      rejected.push({ key, reason: "accessories only after order_now=true" });
      continue;
    }
    const checked = normalizeSelectionValue(next, key, raw);
    if (!checked.ok) {
      rejected.push({ key, reason: checked.reason });
      continue;
    }
    (next as Record<string, unknown>)[key] = checked.value;
    (accepted as Record<string, unknown>)[key] = checked.value;
    if (key === "order_now" && (checked.value === false || checked.value === "none")) {
      next.accessories = "none";
      accepted.accessories = "none";
    }
  }

  return { next, accepted, rejected };
}

export function looksLikeVehicleName(s: string): boolean {
  const q = s.trim();
  if (findModel(q)) return true;
  const lower = q.toLowerCase();
  return MODELS.some((m) =>
    m.grades.some((g) =>
      (g.name_en ?? "").toLowerCase() === lower || (g.name_ar ?? "") === q
    )
  );
}

function colorFromLegacy(value: unknown): unknown {
  if (Array.isArray(value) && value.length > 0) return value[0];
  return value;
}

export function normalizeActions(actions: Action[] | undefined): Action[] {
  const fields: Record<string, unknown> = {};
  const out: Action[] = [];
  for (const action of actions ?? []) {
    switch (action.type) {
      case "patch_selection":
        Object.assign(fields, action.fields ?? {});
        break;
      case "upsert_fact": {
        const key = action.key === "colours" || action.key === "colour" ? "color" : action.key;
        if (key === "preferred_channel" || key === "full_name" || key === "customer_name") {
          break;
        }
        if (key === "accessories" && action.declined) {
          fields.accessories = "none";
        } else if (key === "color") {
          fields.color = colorFromLegacy(action.value);
        } else {
          fields[key] = action.declined && key === "order_now" ? false : action.value;
        }
        break;
      }
      case "update_step_context":
      case "advance_step":
        break;
      default:
        out.push(action);
    }
  }
  if (Object.keys(fields).length > 0) {
    out.push({ type: "patch_selection", fields: fields as Partial<Selection> });
  }
  return out;
}

export function validateActions(pack: Pack, actions: Action[]): { accepted: Action[]; rejected: Rejection[] } {
  const accepted: Action[] = [];
  const rejected: Rejection[] = [];
  let working = readSelection(pack);

  for (const action of normalizeActions(actions)) {
    switch (action.type) {
      case "opt_out":
        accepted.push(action);
        break;
      case "set_gender": {
        const gender = action.gender_form;
        if (gender !== "m" && gender !== "f") {
          rejected.push({ action, reason: "gender_form must be m or f" });
        } else if (pack.lead?.gender_form === "m" || pack.lead?.gender_form === "f") {
          rejected.push({ action, reason: "gender already set" });
        } else {
          accepted.push(action);
        }
        break;
      }
      case "set_name": {
        const name = String(action.full_name ?? "").trim();
        if (name.length < 2 || name.length > 80) {
          rejected.push({ action, reason: "full_name must be 2-80 chars" });
        } else if (looksLikeVehicleName(name)) {
          rejected.push({ action, reason: `"${name}" is a catalogue vehicle, not a customer name` });
        } else {
          accepted.push(action);
        }
        break;
      }
      case "set_channel":
        if (!["whatsapp", "call_now", "schedule"].includes(action.choice)) {
          rejected.push({ action, reason: "invalid choice" });
        } else if (pack.lead?.current_channel !== "unset" && action.choice === "whatsapp") {
          rejected.push({ action, reason: "channel already chosen" });
        } else {
          accepted.push(action);
        }
        break;
      case "patch_selection": {
        const result = applySelectionPatch(working, action.fields as Record<string, unknown>);
        for (const r of result.rejected) {
          rejected.push({ action, reason: `${r.key}: ${r.reason}` });
        }
        if (Object.keys(result.accepted).length > 0) {
          accepted.push({ type: "patch_selection", fields: result.accepted });
          working = result.next;
        } else if (result.rejected.length === 0) {
          rejected.push({ action, reason: "patch_selection had no fields" });
        }
        break;
      }
      default:
        rejected.push({ action: action as Action, reason: "unknown action type" });
    }
  }

  return { accepted, rejected };
}

export function replyCompromised(rejected: Rejection[]): boolean {
  return rejected.some((r) =>
    r.action.type === "opt_out" ||
    (r.action.type === "set_channel" && r.action.choice !== "whatsapp")
  );
}

export function leadTemperature(sel: Selection): "hot" | "cold" {
  if (sel.order_now === false || sel.order_now === "none" || sel.timing === "over_month") return "cold";
  return "hot";
}

export function isConfirm(text: string): boolean {
  const f = foldAr(text);
  if (!f || f.length > 24 || /[?؟]/.test(text)) return false;
  return /^(ايه|ايوه|اي|نعم|تمام|يلا|اكيد|ابشر|يب|موافق|yes|ok|okay|confirm|يلانكمل|ايهنعم|تماماكيد)$/.test(f);
}

export function wantsCall(text: string): boolean {
  const f = foldAr(text);
  return /(اتصل|اتصال|كلموني|كلمني|رنعلي|callback|schedule)/.test(f) || /\bcall\b/i.test(text);
}

/** Drop a follow-up question when the customer asked something and the reply should only answer it. */
export function answerOnly(reply: string): string {
  const sentences = String(reply ?? "").split(/(?<=[.!?؟])\s+/);
  const kept: string[] = [];
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (!/[?؟]/.test(trimmed)) {
      kept.push(trimmed);
      continue;
    }
    const before = trimmed.slice(0, trimmed.search(/[?؟]/));
    const clause = before.search(/(?:^|[.،,]\s*)(?:وش|ايش|كم|ليش|كيف|هل|لونك|what|which|how)(?=\s|$|[،,?:؟])/i);
    if (clause > 0) {
      const head = before.slice(0, clause).replace(/[،,\s]+$/, "").trim();
      if (head) kept.push(head);
    }
  }
  const joined = kept.join(" ").replace(/[ \t]{2,}/g, " ").trim();
  return joined || String(reply ?? "").trim();
}

export function isQuestion(text: string): boolean {
  const t = String(text ?? "").trim();
  if (/[?؟]/.test(t)) return true;
  return /^(وش|ايش|كم|ليش|كيف|متى|هل|what|why|how|when)\b/i.test(t);
}

/** Bare تأجير is a rental. The customer-facing lease phrase is always the full one. */
export function sayLease(text: string): string {
  return String(text ?? "").replace(
    /(?:ت[أاإآ]جير|إيجار|ايجار)(?:\s*منتهي\s*بالتمليك)?/g,
    "تأجير منتهي بالتمليك",
  );
}

export function stripEmoji(text: string): string {
  return String(text ?? "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u200D\uFE0F]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([،.!?])/g, "$1")
    .trim();
}

/** @deprecated used only while voice-hub maps structuredData into a patch */
export function checkFactValue(pack: Pack, key: string, value: unknown, declined: boolean): string | null {
  if (declined && key === "accessories") return null;
  const mapped = key === "colours" || key === "colour" ? "color" : key;
  if (!(SELECTION_KEYS as readonly string[]).includes(mapped)) {
    return mapped === "grade" ? null : `unknown selection key ${key}`;
  }
  const current = readSelection(pack);
  const checked = normalizeSelectionValue(current, mapped as SelectionKey, value);
  return checked.ok ? null : checked.reason;
}
