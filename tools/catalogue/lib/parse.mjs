import * as cheerio from "cheerio";

/** Latin labels only when the site writes them, or this published-Arabic map. */
export const GRADE_EN = {
  تريند: "Trend",
  سمارت: "Smart",
  ليميتد: "Limited",
  كلاسيك: "Classic",
  بلاتينيوم: "Platinum",
  رويال: "Royal",
  "فل كامل": "Full",
  إيليت: "Elite",
  "إس ڤي بي": "SVP",
  "يوني-ڤي سبورت": "UNI-V Sport",
  "أوميجا دفع ثنائي": "Omega 2WD",
  "أوميجا دفع رباعي": "Omega 4WD",
  "دلتا دفع رباعي": "Delta 4WD",
};

export function collapse(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSar(text) {
  const indic = "٠١٢٣٤٥٦٧٨٩";
  let s = String(text ?? "").replace(/[٠-٩]/g, (ch) => String(indic.indexOf(ch)));
  s = s.replace(/[^\d.,]/g, "").replace(/,/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseSitemap(xml) {
  const locs = [...String(xml).matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)].map((m) =>
    collapse(m[1]),
  );
  return {
    urls: locs,
    vehicles: locs.filter((url) => /\/vehicle\/[A-Za-z0-9-]+\/?$/.test(url)),
  };
}

export function vehicleIdFromUrl(url) {
  const match = String(url).match(/\/vehicle\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]).replace(/\/$/, "") : null;
}

function splitGradeName(raw) {
  const text = collapse(raw);
  const paren = text.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    const published = collapse(paren[2]);
    return {
      name_ar: collapse(paren[1]),
      name_en: published.replace(/\w+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
      name_en_source: "published",
    };
  }
  const mapped = GRADE_EN[text];
  return {
    name_ar: text,
    name_en: mapped ?? null,
    name_en_source: mapped ? "transliteration_map" : null,
  };
}

function pickDesktopTrimTable($) {
  const tables = $("#trims-section table").toArray();
  const desktop = tables.find((table) => {
    const first = collapse($(table).find("thead th").first().text());
    return $(table).find("thead th").length >= 2 && first === "";
  });
  return desktop ? $(desktop) : tables[0] ? $(tables[0]) : null;
}

function parseColours($) {
  const seen = new Set();
  const colours = [];
  $("img.car-colors").each((_, el) => {
    const name_ar = collapse($(el).attr("data-name") || $(el).attr("alt"));
    if (!name_ar) return;
    const swatch_url = $(el).attr("src") || null;
    const image_path = $(el).attr("data-id") || null;
    const key = `${name_ar}|${swatch_url}|${image_path}`;
    if (seen.has(key)) return;
    seen.add(key);
    colours.push({
      id: `${name_ar}-${colours.length + 1}`,
      name_ar,
      swatch_url,
      image_path,
    });
  });
  return colours;
}

function parseGrades($) {
  const table = pickDesktopTrimTable($);
  if (!table) return [];

  const headers = table
    .find("thead th")
    .toArray()
    .map((th) => collapse($(th).text()));
  const names = headers[0] === "" ? headers.slice(1) : headers;
  if (!names.length) return [];

  const chips = $(".trim-chip[data-trim]")
    .toArray()
    .map((el) => ({
      id: $(el).attr("data-trim") || null,
      name_ar: collapse($(el).text()),
    }));

  let ex = [];
  let inc = [];
  table.find("tbody tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .toArray()
      .map((td) => collapse($(td).text()));
    if (!cells.length) return;
    const label = cells[0];
    const values = cells.slice(1).map(parseSar);
    if (label.includes("بدون ضريبة")) ex = values;
    if (label.includes("بعد الضريبة")) inc = values;
  });

  return names.map((raw, i) => {
    const names = splitGradeName(raw);
    const chip = chips[i] ?? chips.find((c) => c.name_ar === names.name_ar);
    return {
      id: chip?.id ?? `${names.name_en || names.name_ar || "grade"}-${i + 1}`,
      ...names,
      price_ex_vat_sar: ex[i] ?? null,
      price_incl_vat_sar: inc[i] ?? null,
    };
  });
}

function parseHero($) {
  const title = collapse($("title").first().text());
  const denied = /access denied|غير مصرح/i.test(title);
  const fromTitle = title.replace(/\s*\|\s*Changan KSA\s*$/i, "");
  const fromHero = collapse(
    $("p.font-en.text-5xl, p.font-en.text-7xl")
      .filter((_, el) => !/^\d{4}$/.test(collapse($(el).text())))
      .first()
      .text(),
  );
  const name = denied ? fromTitle : fromHero || fromTitle;
  const yearText = collapse(
    $("p.font-en.text-lg, p.font-en")
      .filter((_, el) => /^\d{4}$/.test(collapse($(el).text())))
      .first()
      .text(),
  );
  const heroBlock = $("p.font-en.text-5xl, p.font-en.text-7xl").first().parent().text();
  const startMatch =
    heroBlock.match(/بسعر يبدأ من\s*([\d٬,\u0660-\u0669]+)/) ||
    heroBlock.match(/السعر\s*([\d٬,\u0660-\u0669]+)/);
  return {
    denied,
    name,
    year: yearText || null,
    starting_price_incl_vat_sar: startMatch ? parseSar(startMatch[1]) : null,
  };
}

export function parseVehicle(html, { url, id, status }) {
  const $ = cheerio.load(html);
  const hero = parseHero($);
  if (hero.denied || status === 403) {
    return {
      id,
      url,
      status: "unavailable",
      http_status: status ?? 403,
      name: id,
      line: id.startsWith("UNI") ? "uni" : "changan",
      year: null,
      starting_price_incl_vat_sar: null,
      grades: [],
      notes: ["Vehicle URL is in the sitemap but the page is access-denied."],
    };
  }

  const colours = parseColours($);
  const grades = parseGrades($).map((grade) => ({
    ...grade,
    colours,
  }));

  const notes = [];
  if (grades.length < 2) {
    notes.push("Fewer than 2 published grades on this page.");
  }
  if (!colours.length) notes.push("No colour selector found.");

  return {
    id,
    url,
    status: "ok",
    http_status: status ?? 200,
    name: hero.name || id,
    line: id.startsWith("UNI") ? "uni" : "changan",
    year: hero.year,
    starting_price_incl_vat_sar: hero.starting_price_incl_vat_sar,
    grades,
    notes,
  };
}

export function parseHomeStartingPrices(html) {
  const $ = cheerio.load(html);
  const byId = {};
  const nameToId = {
    ALSVIN: "ALSVIN",
    "CS 75 PLUS": "CS-75-PLUS",
    "CS 35 PLUS": "CS-35-PLUS",
    "CS 95": "CS-95",
    "EADO PLUS": "EADO-PLUS",
    HUNTER: "HUNTER-PLUS",
    "UNI T": "UNI-T",
    "UNI V": "UNI-V",
    "UNI S": "UNI-S",
    "UNI K": "UNI-K",
  };

  $("p, span, li, a, div").each((_, el) => {
    const text = collapse($(el).text());
    if (text.length > 80) return;
    const start = text.match(/^(?:بسعر يبدأ من|السعر)\s*([\d٬,]+)/);
    if (!start) return;
    const prev = collapse($(el).prev().text()) || collapse($(el).parent().prev().text());
    const key = prev.replace(/\s+/g, " ").toUpperCase();
    const id = nameToId[key];
    if (id && byId[id] == null) byId[id] = parseSar(start[1]);
  });
  return byId;
}

export function parseParts(html, { url } = {}) {
  const $ = cheerio.load(html);
  const accessories = [];
  $(".parts-heading").each((_, heading) => {
    const group = collapse($(heading).find("span").first().text()) || collapse($(heading).text());
    const body = $(heading).next(".parts-body");
    body.find("table tbody tr").each((__, tr) => {
      const cells = $(tr)
        .find("td")
        .toArray()
        .map((td) => collapse($(td).text()));
      if (cells.length < 5) return;
      const [part_number, name_en, name_ar, ex, inc] = cells;
      accessories.push({
        id: `${group}-${part_number}`.replace(/\s+/g, "-"),
        kind: "spare_part",
        vehicle_group: group,
        part_number,
        name_en,
        name_ar,
        price_ex_vat_sar: parseSar(ex),
        price_incl_vat_sar: parseSar(inc),
        price_status: parseSar(inc) == null ? "unpublished" : "published",
        source_url: url ?? "https://changan-ksa.com/parts",
      });
    });
  });
  return accessories;
}

export function validateCatalogue(catalogue) {
  const warnings = [];
  const errors = [];
  const okModels = catalogue.models.filter((m) => m.status === "ok");
  const multiGrade = okModels.filter(
    (m) => m.grades.filter((g) => g.price_incl_vat_sar != null).length >= 2,
  );
  if (okModels.length < 3) errors.push("Need at least 3 parsed models.");
  if (multiGrade.length < 3) {
    errors.push("Need at least 3 models with 2+ priced grades.");
  }
  const pricedAccessories = catalogue.accessories.filter(
    (a) => a.price_status === "published",
  );
  if (pricedAccessories.length < 6 && catalogue.accessories.length < 6) {
    errors.push("Need at least 6 accessories (priced or unpublished placeholders).");
  }

  for (const model of okModels) {
    const minGrade = Math.min(
      ...model.grades.map((g) => g.price_incl_vat_sar).filter((n) => n != null),
    );
    if (
      Number.isFinite(minGrade) &&
      model.starting_price_incl_vat_sar != null &&
      minGrade !== model.starting_price_incl_vat_sar
    ) {
      warnings.push(
        `${model.id}: homepage/hero starting price ${model.starting_price_incl_vat_sar} != cheapest grade ${minGrade}.`,
      );
    }
    if (model.grades.some((g) => !g.colours?.length)) {
      warnings.push(`${model.id}: a grade is missing colours.`);
    }
    if (model.grades.length < 2) warnings.push(`${model.id}: fewer than 2 grades.`);
  }

  return { ok: errors.length === 0, errors, warnings };
}
