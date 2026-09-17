export const code = async (inputs) => {
  const pack = inputs.pack || {};
  const lead = pack.lead || {};
  const latest = pack.latest_submission || {};
  const ar = lead.language === "ar";
  const raw = String(inputs.text ?? "").toLowerCase().trim();
  const names = {"ALSVIN":"ALSVIN","CS-35-PLUS":"CS 35 Plus","CS-75-PLUS":"CS 75 Plus","CS-95":"CS 95","EADO-PLUS":"EADO Plus","HUNTER-PLUS":"Hunter","UNI-K":"UNI-K","UNI-S":"UNI S","UNI-T":"UNI-T","UNI-V":"UNI V"};
  const vehicle = names[latest.vehicle] || latest.vehicle || (ar ? "سيارتك" : "your car");
  const firstName = String(lead.full_name || "").trim().split(/\s+/)[0] || "";
  const has = (words) => words.some((w) => raw.includes(w));

  const cancelled = has(["cancel", "الغاء", "إلغاء", "لا ابي", "لا أبي"]);
  const schedule = !cancelled && (raw === "3" || has(["schedule", "later", "بعدين", "موعد", "باكر", "بكره", "بكرة", "وقت"]));
  const callNow = !cancelled && !schedule && (raw === "2" || has(["call", "اتصل", "اتصال", "كلمني", "كلموني", "رن"]));
  const whatsapp = !cancelled && !schedule && !callNow && (raw === "1" || has(["whatsapp", "chat", "text", "message", "واتس", "هنا", "نكمل", "اكمل", "أكمل", "كتابه", "كتابة"]));

  const to = String(inputs.mobile ?? "");
  const send = (body) => ({ channelId: "160e6c61-174a-4de1-b338-ce2e27666c37", to, type: "text", text: { body, previewUrl: false } });
  const log = (body, kind) => ({ p_mobile: to, p_text: body, p_channel: "whatsapp", p_step: "channel", p_handler: "inbound", p_meta: { kind } });

  let mode = "ask";
  let choice = null;
  let copy = null;
  if (whatsapp) { mode = "set_choice"; choice = "whatsapp"; }
  else if (callNow) { mode = "set_choice"; choice = "call_now"; }
  else if (schedule) { mode = "set_choice"; choice = "schedule"; }
  else if (cancelled) {
    mode = "cancel";
    copy = ar
      ? "تم إلغاء طلبك، ولا يهمك. إذا حبيت ترجع لنا، أرسل هنا بأي وقت."
      : "Your request has been cancelled. If you change your mind, just message us here anytime.";
  }
  // mode "ask" (no keyword hit, not a cancel): the inbound-brain node answers
  // semantically — off-topic replies, implied choices, missed opt-outs.

  return {
    mode,
    choice,
    rpcBody: { p_mobile: to, p_choice: choice, p_preferred_call_at: null },
    sendBody: copy ? send(copy) : null,
    logBody: copy ? log(copy, "cancel_ack") : null,
  };
};
