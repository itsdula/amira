# Changan KSA catalogue scrape

One polite pass over [changan-ksa.com](https://changan-ksa.com/). Repeatable: run the script again; do not copy-paste prices.

## Why a script, not a site dump

The sitemap is the index. We only fetch `robots.txt`, the sitemap, the homepage (starting-price check), each `/vehicle/{id}`, and `/parts`. News, offers, and Drupal internals stay untouched. That is enough for every published model, grade, colour, and priced spare part.

## Respect the site

- Named UA: `AmiraCatalogueBot/1.0`
- `robots.txt` is fetched first. `/vehicle/` and `/parts` are allowed; `/admin/`, `/search/`, `/user/*`, `/core/` are not.
- Default gap between requests: **1500 ms**. Override with `--delay-ms`.
- Raw HTML is saved so you can re-parse without hitting the site.

## Run

```bash
cd tools/catalogue
npm install
npm run scrape
```

Offline re-parse of a saved capture:

```bash
node scrape.mjs --from-raw raw/2026-09-13
# or the earlier audit dump:
npm run scrape:offline
```

Writes:

- `out/catalogue.json` — structured catalogue the assistant must quote from
- `raw/<date>/` — robots, sitemap, homepage, each vehicle page, parts, fetch log

## Known gaps (left in the JSON)

- Colours live on each **grade**. The site has one picker per model, so every grade on that page gets the same array.
- ALSVIN and UNI-K publish **one** grade. The brief’s “≥2 grades” bar is met by the other models.
- UNI-S is on the UNI homepage tab. An earlier capture got 403; the live pass in `raw/2026-09-13` received 200 (Platinum 84,985 / Royal 97,635).
- Showroom extras (mats, film, packs) have **no published retail price**. `/parts` has spare-part SAR; those rows are `kind: spare_part` with real prices. Do not invent option-pack numbers.
