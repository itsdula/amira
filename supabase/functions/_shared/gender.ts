// gender_form is a hint for the model, not a script.
// A trailing ه/ة is not gender: عبدالله ends in ه and is masculine.
// Anything we are not sure about stays "unknown" so the model can hear the name.

export function guessGender(fullName: string | null | undefined): "m" | "f" | "unknown" {
  const first = String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
  if (!first) return "unknown";
  if (/^عبد/u.test(first) || /^abd(ul|ullah)/i.test(first)) return "m";
  return "unknown";
}
