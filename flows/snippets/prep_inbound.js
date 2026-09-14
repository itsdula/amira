export const code = async (inputs) => {
  const mt = String(inputs.messageType ?? "text");
  let text = String(inputs.text ?? "").trim();
  if (!text) text = "[" + mt + " message]";
  return {
    body: {
      p_mobile: String(inputs.mobile ?? ""),
      p_text: text,
      p_channel: "whatsapp",
      p_meta: {
        event_id: inputs.eventId ?? null,
        message_id: inputs.messageId ?? null,
        message_type: mt,
        window_state: inputs.windowState ?? null,
      },
    },
  };
};
