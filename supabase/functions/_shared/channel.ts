export type ChannelChoice = "whatsapp" | "call_now" | "schedule";
export type ChannelHit = { mode: "set_choice"; choice: ChannelChoice } | { mode: "cancel" } | { mode: "ask" };

export function normalizeMobile(raw: string): string {
  const t = String(raw ?? "").trim();
  return t && !t.startsWith("+") ? `+${t}` : t;
}

export function parseInboundEvent(e: Record<string, unknown>): {
  eventType: string;
  eventId: string | null;
  mobile: string;
  text: string;
  messageType: string;
  messageId: string | null;
} {
  const mt = String(e.messageType ?? "text");
  let text = String(e.text ?? "").trim();
  if (!text) text = `[${mt} message]`;
  return {
    eventType: String(e.eventType ?? ""),
    eventId: e.eventId ? String(e.eventId) : null,
    mobile: normalizeMobile(String(e.senderIdentifier ?? "")),
    text,
    messageType: mt,
    messageId: e.messageId ? String(e.messageId) : null,
  };
}

function has(raw: string, words: string[]): boolean {
  return words.some((w) => raw.includes(w));
}

export function detectChannel(text: string): ChannelHit {
  const raw = String(text ?? "").toLowerCase().trim();
  const cancelled = raw === "cancel" || raw === "إلغاء" || raw === "الغاء" ||
    has(raw, ["cancel", "الغاء", "إلغاء", "لا ابي", "لا أبي"]);
  const schedule = !cancelled && (
    raw === "3" || raw === "later" || raw === "وقت لاحق" ||
    has(raw, ["schedule", "later", "بعدين", "موعد", "باكر", "بكره", "بكرة", "وقت"])
  );
  const callNow = !cancelled && !schedule && (
    raw === "2" || has(raw, ["call", "اتصل", "اتصال", "كلمني", "كلموني", "رن"])
  );
  const whatsapp = !cancelled && !schedule && !callNow && (
    raw === "1" || raw === "confirm" || raw === "تأكيد" ||
    has(raw, ["whatsapp", "chat", "text", "message", "واتس", "هنا", "نكمل", "اكمل", "أكمل", "كتابه", "كتابة", "confirm"])
  );

  if (whatsapp) return { mode: "set_choice", choice: "whatsapp" };
  if (callNow) return { mode: "set_choice", choice: "call_now" };
  if (schedule) return { mode: "set_choice", choice: "schedule" };
  if (cancelled) return { mode: "cancel" };
  return { mode: "ask" };
}

export function confirmCopy(opts: {
  choice: ChannelChoice;
  language: string;
  vehicle: string;
  windowOpen: boolean;
}): string {
  const ar = opts.language === "ar";
  if (opts.choice === "whatsapp") {
    return ar
      ? `تمام، نكمل هنا. بس أتأكد منك أول، طلبك على ${opts.vehicle} صح؟`
      : `Great, we will continue here. First, just to confirm - your request is for the ${opts.vehicle}, right?`;
  }
  if (opts.choice === "call_now") {
    return opts.windowOpen
      ? (ar ? "أبشر، بنتصل عليك الحين على هالرقم." : "Sure - we will call you now on this number.")
      : (ar
        ? "أبشر، بس الحين برا أوقات الاتصال (من ٩ الصبح إلى ٩ بالليل). بنتصل عليك أول ما نبدأ الساعة ٩ الصبح، يناسبك؟"
        : "Sure - we are outside calling hours right now (9am to 9pm). We will call you when lines open at 9am, does that work?");
  }
  return ar
    ? "أبشر. وش الوقت اللي يناسبك نتصل عليك فيه؟ متاحين من ٩ الصبح إلى ٩ بالليل."
    : "Sure. What time works best for the call? We are available 9am to 9pm.";
}

export function cancelCopy(language: string): string {
  return language === "ar"
    ? "تم إلغاء طلبك، ولا يهمك. إذا حبيت ترجع لنا، أرسل هنا بأي وقت."
    : "Your request has been cancelled. If you change your mind, just message us here anytime.";
}
