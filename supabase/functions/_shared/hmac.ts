export async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/** Voice / chat: `sha256=<hex>` over the raw body. Messaging: `t=<unix>,v1=<hex>` over `v1:{t}:{body}`. */
export async function verifySignature(raw: string, header: string, secret: string): Promise<boolean> {
  if (!header || !secret) return false;
  if (header.includes("v1=")) {
    const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
    const t = parts["t"];
    if (!t || !parts["v1"]) return false;
    if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
    const expected = await hmacHex(secret, `v1:${t}:${raw}`);
    return safeEq(parts["v1"], expected);
  }
  const bare = header.replace(/^sha256=/, "");
  return safeEq(bare, await hmacHex(secret, raw));
}
