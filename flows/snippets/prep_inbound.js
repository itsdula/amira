export const code = async (inputs) => {
  const pick = (v) => (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
  const e = pick(inputs.evt) || pick(inputs.evtAlt) || {};
  const mt = String(e.messageType ?? "text");
  let text = String(e.text ?? "").trim();
  if (!text) text = "[" + mt + " message]";
  // AF delivers senderIdentifier WITHOUT the leading + — normalize to E.164.
  let mobile = String(e.senderIdentifier ?? "").trim();
  if (mobile && !mobile.startsWith("+")) mobile = "+" + mobile;
  return {
    eventType: String(e.eventType ?? ""),
    mobile,
    text,
    body: {
      p_mobile: mobile,
      p_text: text,
      p_channel: "whatsapp",
      p_meta: {
        event_id: e.eventId ?? null,
        message_id: e.messageId ?? null,
        message_type: mt,
        window_state: e.windowState ?? null,
      },
    },
  };
};
