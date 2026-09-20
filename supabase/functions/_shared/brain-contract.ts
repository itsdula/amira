// inbound-brain action contract: the LLM proposes, this file decides.
// Pure functions of (pack, actions) — no model, no network. Unit-testable,
// and the eval suite replays adversarial action lists through it.

import { findGrade, findModel, MODELS } from "./catalogue.ts";

export type Action =
  | { type: "set_channel"; choice: "whatsapp" | "call_now" | "schedule"; preferred_call_at?: string | null }
  | { type: "opt_out" }
  | { type: "set_name"; full_name: string }
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
  };
  latest_submission?: { vehicle?: string | null };
  facts?: Record<string, { value: unknown; declined: boolean }>;
  next_action?: string;
};

// Facts each step may write (mirror of requirements/store-micro-context.md).
export const FACTS_OWNED: Record<string, string[]> = {
  channel: ["preferred_channel"],
  vehicle: ["vehicle", "grade"],
  payment: ["payment"],
  colours: ["colours"],
  order_gate: ["order_now"],
  accessories: ["accessories"],
  timing: ["timing"],
  close: [],
  done: [],
};

// Facts that MUST be covered (value or decline) before leaving a step.
// Subset of FACTS_OWNED: optional details (e.g. grade) don't block exit.
export const REQUIRED_FOR_EXIT: Record<string, string[]> = {
  channel: ["preferred_channel"],
  vehicle: ["vehicle"],
  payment: ["payment"],
  colours: ["colours"],
  order_gate: ["order_now"],
  accessories: ["accessories"],
  timing: ["timing"],
  close: [],
  done: [],
};

// Legal step transitions — the qualification order the brief mandates.
// order_gate may jump to close (customer said no: COLD, skip accessories).
export const TRANSITIONS: Record<string, string[]> = {
  channel: ["vehicle"],
  vehicle: ["payment"],
  payment: ["colours"],
  colours: ["order_gate"],
  order_gate: ["accessories", "close"],
  accessories: ["timing"],
  timing: ["close"],
  close: ["done"],
  done: [],
};

const PAYMENTS = new Set(["cash", "finance", "lease"]);
const TIMINGS = new Set(["now", "over_month"]);

export function checkFactValue(pack: Pack, key: string, value: unknown, declined: boolean): string | null {
  if (declined) return null; // a decline is coverage; no value to check
  switch (key) {
    case "payment":
      return PAYMENTS.has(String(value)) ? null : `payment must be cash | finance | lease, got ${JSON.stringify(value)}`;
    case "timing":
      return TIMINGS.has(String(value)) ? null : `timing must be now | over_month, got ${JSON.stringify(value)}`;
    case "order_now":
      return typeof value === "boolean" ? null : "order_now must be boolean";
    case "vehicle":
      return findModel(String(value)) ? null : `vehicle ${JSON.stringify(value)} is not in the catalogue`;
    case "grade": {
      const vehicleFact = pack.facts?.vehicle?.value ?? pack.latest_submission?.vehicle;
      const model = findModel(String(vehicleFact ?? ""));
      if (!model) return "grade requires a known vehicle first";
      return findGrade(model, String(value)) ? null : `grade ${JSON.stringify(value)} does not exist on ${model.name}`;
    }
    case "colours": {
      if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
        return "colours must be an array of 1-3 ranked choices";
      }
      const vehicleFact = pack.facts?.vehicle?.value ?? pack.latest_submission?.vehicle;
      const model = findModel(String(vehicleFact ?? ""));
      if (!model) return "colours require a known vehicle first";
      const known = new Set(model.grades.flatMap((g) => g.colours));
      const bad = value.filter((c) => !known.has(String(c)));
      return bad.length === 0 ? null : `colours not in catalogue for ${model.name}: ${bad.join(", ")}`;
    }
    case "accessories":
      return Array.isArray(value) ? null : "accessories must be an array of names";
    case "preferred_channel":
      return ["whatsapp", "call_now", "schedule"].includes(String(value)) ? null : "invalid preferred_channel";
    default:
      return `unknown fact key ${key}`;
  }
}

// A proposed customer name that is actually a catalogue model/grade is a
// model slip (e.g. answering the vehicle question got routed into set_name).
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

export function validateActions(pack: Pack, actions: Action[]): { accepted: Action[]; rejected: Rejection[] } {
  const accepted: Action[] = [];
  const rejected: Rejection[] = [];
  const step = pack.lead?.current_step ?? "channel";
  const owned = FACTS_OWNED[step] ?? [];

  // advance_step is validated in a second pass so the coverage check can see
  // facts accepted in THIS turn regardless of the model's action ordering.
  const deferred: Action[] = [];

  for (const action of actions ?? []) {
    switch (action.type) {
      case "opt_out":
        accepted.push(action); // add-only, always legal
        break;
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
        if (pack.lead?.current_channel !== "unset") {
          rejected.push({ action, reason: "channel already chosen" });
        } else if (!["whatsapp", "call_now", "schedule"].includes(action.choice)) {
          rejected.push({ action, reason: "invalid choice" });
        } else {
          accepted.push(action);
        }
        break;
      case "upsert_fact": {
        if (!owned.includes(action.key)) {
          rejected.push({ action, reason: `step ${step} may not write ${action.key}` });
          break;
        }
        const problem = checkFactValue(pack, action.key, action.value, action.declined ?? false);
        if (problem) rejected.push({ action, reason: problem });
        else accepted.push(action);
        break;
      }
      case "update_step_context":
        accepted.push(action);
        break;
      case "advance_step":
        deferred.push(action);
        break;
      default:
        rejected.push({ action: action as Action, reason: "unknown action type" });
    }
  }

  // Second pass: a step may only be left once every fact it owns is covered
  // (stored earlier, or accepted this turn). Prevents the skipped-vehicle
  // wedge where later steps can never validate.
  const covered = new Set(Object.keys(pack.facts ?? {}));
  for (const a of accepted) if (a.type === "upsert_fact") covered.add(a.key);

  for (const action of deferred) {
    if (action.type !== "advance_step") continue;
    if (!(TRANSITIONS[step] ?? []).includes(action.step)) {
      rejected.push({ action, reason: `illegal transition ${step} -> ${action.step}` });
      continue;
    }
    const missing = (REQUIRED_FOR_EXIT[step] ?? []).filter((k) => !covered.has(k));
    if (missing.length > 0) {
      rejected.push({ action, reason: `cannot leave ${step}: uncovered facts [${missing.join(", ")}]` });
    } else {
      accepted.push(action);
    }
  }

  return { accepted, rejected };
}

// A rejected action of these types means the model's words likely promise a
// state change that did not happen — discard the reply, use the safe fallback.
export function replyCompromised(rejected: Rejection[]): boolean {
  return rejected.some((r) => r.action.type === "set_channel" || r.action.type === "opt_out");
}
