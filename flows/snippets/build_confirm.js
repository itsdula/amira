export const code = async (inputs) => {
  const pack = inputs.pack || {};
  const lead = pack.lead || {};
  const latest = pack.latest_submission || {};
  const ar = lead.language === "ar";
  const names = {"ALSVIN":"ALSVIN","CS-35-PLUS":"CS 35 Plus","CS-75-PLUS":"CS 75 Plus","CS-95":"CS 95","EADO-PLUS":"EADO Plus","HUNTER-PLUS":"Hunter","UNI-K":"UNI-K","UNI-S":"UNI S","UNI-T":"UNI-T","UNI-V":"UNI V"};
  const vehicle = names[latest.vehicle] || latest.vehicle || (ar ? "سيارتك" : "your car");
  const choice = String(inputs.choice ?? "");
  const windowOpen = pack.call_window === "open";

  let copy;
  if (choice === "whatsapp") {
    copy = ar
      ? "تمام، نكمل هنا. بس أتأكد منك أول، طلبك على " + vehicle + " صح؟"
      : "Great, we will continue here. First, just to confirm - your request is for the " + vehicle + ", right?";
  } else if (choice === "call_now") {
    copy = windowOpen
      ? (ar ? "أبشر، بنتصل عليك الحين على هالرقم." : "Sure - we will call you now on this number.")
      : (ar ? "أبشر، بس الحين برا أوقات الاتصال (من ٩ الصبح إلى ٩ بالليل). بنتصل عليك أول ما نبدأ الساعة ٩ الصبح، يناسبك؟" : "Sure - we are outside calling hours right now (9am to 9pm). We will call you when lines open at 9am, does that work?");
  } else {
    copy = ar
      ? "أبشر. وش الوقت اللي يناسبك نتصل عليك فيه؟ متاحين من ٩ الصبح إلى ٩ بالليل."
      : "Sure. What time works best for the call? We are available 9am to 9pm.";
  }

  const to = String(inputs.mobile ?? "");
  return {
    sendBody: { channelId: "160e6c61-174a-4de1-b338-ce2e27666c37", to, type: "text", text: { body: copy, previewUrl: false } },
    logBody: { p_mobile: to, p_text: copy, p_channel: "whatsapp", p_step: "channel", p_handler: "inbound", p_meta: { kind: "channel_" + choice } },
  };
};
