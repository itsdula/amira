import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const USER_AGENT =
  "AmiraCatalogueBot/1.0 (+one-pass KSA demo catalogue; respects robots.txt)";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchText(url, { dest, delayMs = 1500, lastRequestAt } = {}) {
  if (lastRequestAt) {
    const wait = delayMs - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
  }

  const started = Date.now();
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xml,text/plain;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });
  const body = await response.text();

  if (dest) {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, body);
  }

  return {
    url: response.url || url,
    status: response.status,
    ok: response.ok,
    body,
    fetchedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    requestedAt: started,
  };
}
