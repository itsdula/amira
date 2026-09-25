export function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) return JSON.parse(raw)["default"];
  throw new Error("Missing service role key");
}

export function afApiKey(): string {
  const key = Deno.env.get("AGENTICFLOW_API_KEY");
  if (!key) throw new Error("Missing AGENTICFLOW_API_KEY");
  return key;
}
