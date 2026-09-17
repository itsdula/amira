// Gender form from the first name — list first, suffix heuristic second,
// honest "unknown" otherwise (the spec forbids guessing beyond the name).

const FEMALE = new Set([
  "نورة", "نوره", "سارة", "ساره", "منيرة", "منيره", "هيا", "لطيفة", "لطيفه",
  "عائشة", "عايشة", "فاطمة", "فاطمه", "مريم", "نوف", "ريم", "رهف", "دانة", "دانه",
  "جواهر", "عهود", "شهد", "غادة", "غاده", "أمل", "امل", "هند", "لولوة", "الجوهرة",
  "منى", "لمى", "أريج", "اريج", "وعد", "رنا", "دلال", "بدور", "مها", "أسماء", "اسماء",
  "sara", "sarah", "fatima", "fatimah", "maryam", "mariam", "noura", "nora",
  "reem", "shahad", "hind", "mona", "amal", "dana",
]);

// Male names ending in ة/اء that the suffix rule would misread.
const MALE_EXCEPTIONS = new Set([
  "حمزة", "حمزه", "أسامة", "اسامة", "اسامه", "معاوية", "طلحة", "عبيدة", "زكريا", "يحيى", "عيسى", "موسى",
]);

export function guessGender(fullName: string | null | undefined): "m" | "f" | "unknown" {
  const first = String(fullName ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!first) return "unknown";
  if (FEMALE.has(first)) return "f";
  if (MALE_EXCEPTIONS.has(first)) return "m";
  if (/[ةه]$/.test(first) && first.length > 3) return "f"; // common but not certain
  if (/^(محمد|أحمد|احمد|عبد|فهد|خالد|سعود|سلطان|بندر|تركي|نايف|فيصل|عمر|علي|سعد|ماجد|مشعل|طلال|نواف|يوسف|إبراهيم|ابراهيم|عبدالله|عبدالعزيز|عبدالرحمن|mohammed|mohammad|ahmed|ahmad|khalid|fahad|faisal|omar|ali|saad|majed|sultan|bandar|turki|naif|nawaf|yousef|ibrahim|abdullah|abdulaziz|abdulrahman)/.test(first)) {
    return "m";
  }
  return "unknown";
}
