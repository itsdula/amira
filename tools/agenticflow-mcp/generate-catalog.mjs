#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = "https://docs.agenticflow.studio";
const here = dirname(fileURLToPath(import.meta.url));

const INDEX_PATHS = [
  "api-reference/billing/invoices",
  "api-reference/billing/lifecycle",
  "api-reference/billing/plans",
  "api-reference/billing/revenue",
  "api-reference/billing/usage",
  "api-reference/chat/messages",
  "api-reference/chat/sessions",
  "api-reference/knowledge/files",
  "api-reference/knowledge/knowledge-bases",
  "api-reference/messaging/batches",
  "api-reference/messaging/channels",
  "api-reference/messaging/consent",
  "api-reference/messaging/contacts",
  "api-reference/messaging/conversations",
  "api-reference/messaging/media",
  "api-reference/messaging/messages",
  "api-reference/messaging/onboarding",
  "api-reference/messaging/opt-outs",
  "api-reference/messaging/quick-replies",
  "api-reference/messaging/templates",
  "api-reference/messaging/webhook-deliveries",
  "api-reference/voice/assistants",
  "api-reference/voice/calls",
  "api-reference/voice/folders",
  "api-reference/voice/monitor",
  "api-reference/voice/phone-numbers",
  "api-reference/voice/sip-trunks",
  "api-reference/voice/tools",
  "api-reference/organizations/organizations",
  "api-reference/organizations/reporting",
  "api-reference/widgets/articles",
  "api-reference/widgets/audit-webhooks",
  "api-reference/widgets/gdpr",
  "api-reference/widgets/news",
  "api-reference/widgets/surveys",
  "api-reference/widgets/widgets",
];

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

function parseLlms(text) {
  const ops = [];
  const re =
    /^- \[([^\]]+)\]\(\/docs\/(api-reference\/[^\)]+)\)(?::\s*(.*))?$/gm;
  for (const match of text.matchAll(re)) {
    const title = match[1].trim();
    const docsPath = match[2].trim();
    const description = (match[3] || "").trim();
    const parts = docsPath.split("/");
    if (parts.length < 4) continue;
    const family = parts[1];
    const operationId = parts[parts.length - 1];
    const kind = family === "webhook-events" ? "webhook-event" : "http";
    ops.push({ title, docsPath, description, family, operationId, kind });
  }
  return ops;
}

function parseIndexTable(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    const match = line.match(
      /^\|\s*(?:\[([^\]]+)\]\([^)]+\)|([^|]+))\s*\|\s*`([A-Z]+)`\s*\|\s*`([^`]+)`\s*\|/,
    );
    if (!match) continue;
    const title = (match[1] || match[2] || "").trim();
    if (!title || title === "Operation") continue;
    rows.push({
      title,
      method: match[3],
      path: match[4],
    });
  }
  return rows;
}

function familyOf(docsPath) {
  return docsPath.split("/")[1] ?? "";
}

async function main() {
  const llms = await fetchText(`${DOCS}/llms.txt`);
  const fromLlms = parseLlms(llms);

  const indexes = await Promise.all(
    INDEX_PATHS.map(async (path) => ({
      path,
      rows: parseIndexTable(await fetchText(`${DOCS}/llm-content/${path}`)),
    })),
  );

  const byParentTitle = new Map();
  for (const { path, rows } of indexes) {
    for (const row of rows) {
      byParentTitle.set(`${path}::${row.title}`, row);
    }
  }

  const operations = fromLlms.map((op) => {
    const parent = op.docsPath.split("/").slice(0, -1).join("/");
    const row = byParentTitle.get(`${parent}::${op.title}`);
    return {
      operationId: op.operationId,
      title: op.title,
      description: op.description,
      family: op.family,
      kind: op.kind,
      docsPath: op.docsPath,
      method: row?.method ?? null,
      path: row?.path ?? null,
    };
  });

  const catalog = {
    generatedAt: new Date().toISOString(),
    source: `${DOCS}/llms.txt`,
    operations,
  };

  const out = join(here, "catalog.json");
  writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`);
  const http = operations.filter((o) => o.kind === "http").length;
  const withRoute = operations.filter((o) => o.method && o.path).length;
  console.error(
    `Wrote ${operations.length} operations (${http} HTTP, ${withRoute} with method/path) to catalog.json`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
