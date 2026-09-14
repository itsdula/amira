#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchText, USER_AGENT } from "./lib/http.mjs";
import { isAllowed, parseRobots } from "./lib/robots.mjs";
import {
  parseHomeStartingPrices,
  parseParts,
  parseSitemap,
  parseVehicle,
  validateCatalogue,
  vehicleIdFromUrl,
} from "./lib/parse.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const BASE = "https://changan-ksa.com";
const args = process.argv.slice(2);
const fromRaw = argValue("--from-raw");
const delayMs = Number(argValue("--delay-ms") ?? 1500);

function argValue(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  return args[i + 1] ?? "";
}

async function readLocal(path) {
  return { url: path, status: 200, ok: true, body: await readFile(path, "utf8") };
}

async function main() {
  const rawDir = fromRaw
    ? join(ROOT, fromRaw)
    : join(ROOT, "raw", new Date().toISOString().slice(0, 10));
  await mkdir(rawDir, { recursive: true });
  await mkdir(join(ROOT, "out"), { recursive: true });

  const log = [];
  let lastRequestAt = 0;

  async function get(url, filename, { optional = false } = {}) {
    const dest = join(rawDir, filename);
    if (fromRaw) {
      try {
        await access(dest);
      } catch {
        if (optional) {
          log.push({ url, status: 0, source: "raw_missing" });
          return { url, status: 0, ok: false, body: "" };
        }
        throw new Error(`Missing raw capture: ${dest}`);
      }
      const fetched = await readLocal(dest);
      log.push({ url, status: fetched.status, source: "raw" });
      return fetched;
    }
    const fetched = await fetchText(url, { dest, delayMs, lastRequestAt });
    lastRequestAt = fetched.requestedAt;
    log.push({
      url,
      status: fetched.status,
      elapsed_ms: fetched.elapsedMs,
      saved: filename,
    });
    console.error(`${fetched.status} ${url}`);
    return fetched;
  }

  const robotsRes = await get(`${BASE}/robots.txt`, "robots.txt");
  const robots = parseRobots(robotsRes.body);
  const assertAllowed = (path) => {
    if (!isAllowed(robots, path)) {
      throw new Error(`robots.txt disallows ${path}`);
    }
  };

  assertAllowed("/sitemap.xml");
  assertAllowed("/");
  assertAllowed("/parts");
  assertAllowed("/vehicle/CS-35-PLUS");

  const sitemapRes = await get(`${BASE}/sitemap.xml`, "sitemap.xml");
  const sitemap = parseSitemap(sitemapRes.body);
  if (!sitemap.vehicles.length) throw new Error("Sitemap listed no /vehicle/ URLs.");

  for (const url of sitemap.vehicles) {
    const path = new URL(url).pathname;
    assertAllowed(path);
  }

  const homeRes = await get(`${BASE}/`, "index.html", { optional: true });
  const homePrices = homeRes.body ? parseHomeStartingPrices(homeRes.body) : {};

  const models = [];
  for (const url of sitemap.vehicles) {
    const id = vehicleIdFromUrl(url);
    const page = await get(url, `vehicle-${id}.html`);
    const model = parseVehicle(page.body, { url, id, status: page.status });
    if (model.starting_price_incl_vat_sar == null && homePrices[id] != null) {
      model.starting_price_incl_vat_sar = homePrices[id];
      model.notes.push("Starting price taken from the homepage card (page had none).");
    }
    if (model.status === "unavailable" && homePrices[id] != null) {
      model.starting_price_incl_vat_sar = homePrices[id];
      model.notes.push(
        "Grade table unavailable. Homepage starting price recorded only; not a grade price.",
      );
    }
    models.push(model);
  }

  const partsRes = await get(`${BASE}/parts`, "parts.html", { optional: true });
  const accessories = partsRes.body
    ? parseParts(partsRes.body, { url: `${BASE}/parts` })
    : [];

  const catalogue = {
    source: {
      brand: "Changan",
      distributor: "Almajdouie",
      market: "KSA",
      base_url: BASE,
      scraped_at: new Date().toISOString(),
      user_agent: USER_AGENT,
      delay_ms: fromRaw ? 0 : delayMs,
      mode: fromRaw ? "from_raw" : "live",
      robots_url: `${BASE}/robots.txt`,
      sitemap_url: `${BASE}/sitemap.xml`,
    },
    notes: [
      "The site publishes one colour picker per model, not a per-grade list. Each grade stores that same colours array.",
      "Showroom option-pack prices are not published. /parts publishes spare-part retail SAR; those are stored as accessories with kind=spare_part.",
      "ALSVIN and UNI-K publish one grade. UNI-S was 403 on an earlier pass; this run received 200.",
      "Do not invent a figure that is not in this file.",
    ],
    models,
    accessories,
  };

  const check = validateCatalogue(catalogue);
  catalogue.validation = check;

  const outPath = join(ROOT, "out", "catalogue.json");
  await writeFile(outPath, `${JSON.stringify(catalogue, null, 2)}\n`);
  await writeFile(join(rawDir, "fetch-log.json"), `${JSON.stringify(log, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        out: outPath,
        raw: rawDir,
        models: models.map((m) => ({
          id: m.id,
          status: m.status,
          grades: m.grades.length,
          colours: m.grades[0]?.colours?.length ?? 0,
          cheapest_incl_vat: m.grades
            .map((g) => g.price_incl_vat_sar)
            .filter((n) => n != null)
            .sort((a, b) => a - b)[0],
        })),
        accessories: accessories.length,
        priced_accessories: accessories.filter((a) => a.price_status === "published").length,
        validation: check,
      },
      null,
      2,
    ),
  );

  if (!check.ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
