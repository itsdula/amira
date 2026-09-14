#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "../..");
const DOCS_CONTENT = "https://docs.agenticflow.studio/llm-content";
const DEFAULT_API = "https://api.agenticflow.studio";
const MAX_RESPONSE_CHARS = 160_000;

function loadDotEnv() {
  const envPath = join(projectRoot, ".env");
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function requireApiKey() {
  const key = process.env.AGENTIC_FLOW_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "AGENTIC_FLOW_API_KEY is missing. Add it to the project .env (see .env.example).",
    );
  }
  return key;
}

function apiBase() {
  return (process.env.AGENTIC_FLOW_BASE_URL || DEFAULT_API).replace(/\/$/, "");
}

function loadCatalog() {
  const path = join(here, "catalog.json");
  if (!existsSync(path)) {
    throw new Error("catalog.json is missing. Run: npm run catalog");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

const catalog = loadCatalog();

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function jsonResult(value, isError = false) {
  return textResult(JSON.stringify(value, null, 2), isError);
}

function clip(text) {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return `${text.slice(0, MAX_RESPONSE_CHARS)}\n\n…truncated (${text.length} chars)`;
}

const server = new McpServer({
  name: "agenticflow",
  version: "0.1.0",
});

server.tool(
  "list_operations",
  "Search the AgenticFlow API reference catalog. Use this before request to find method, path, and docsPath.",
  {
    query: z
      .string()
      .optional()
      .describe("Case-insensitive match against id, title, path, or description"),
    family: z
      .enum([
        "billing",
        "chat",
        "knowledge",
        "messaging",
        "voice",
        "organizations",
        "widgets",
        "webhook-events",
      ])
      .optional()
      .describe("Product family"),
    kind: z
      .enum(["http", "webhook-event"])
      .optional()
      .describe("http = callable REST ops; webhook-event = inbound payload docs"),
  },
  async ({ query, family, kind }) => {
    const needle = query?.trim().toLowerCase();
    const hits = catalog.operations.filter((op) => {
      if (family && op.family !== family) return false;
      if (kind && op.kind !== kind) return false;
      if (!needle) return true;
      return [op.operationId, op.title, op.path, op.description, op.docsPath]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    });
    return jsonResult({
      generatedAt: catalog.generatedAt,
      count: hits.length,
      operations: hits.slice(0, 80),
    });
  },
);

server.tool(
  "get_operation",
  "Fetch the full API-reference page (OpenAPI operation or webhook payload) as markdown.",
  {
    docsPath: z
      .string()
      .describe(
        'Page path from list_operations, e.g. "api-reference/voice/assistants/createAssistant"',
      ),
  },
  async ({ docsPath }) => {
    const path = docsPath.replace(/^\/+/, "").replace(/^docs\//, "");
    const res = await fetch(`${DOCS_CONTENT}/${path}`);
    if (!res.ok) {
      return textResult(`Failed to fetch ${path}: HTTP ${res.status}`, true);
    }
    return textResult(clip(await res.text()));
  },
);

server.tool(
  "request",
  "Call the AgenticFlow REST API with the workspace API key. Path params must already be substituted. Use list_operations / get_operation for the contract. Workflows, catalogs, exports, and activity log are dashboard-only.",
  {
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
    path: z
      .string()
      .describe('API path starting with /, e.g. "/assistant" or "/call/{id}" already filled'),
    query: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Query string parameters"),
    body: z
      .union([z.record(z.any()), z.array(z.any()), z.string()])
      .optional()
      .describe("JSON body for POST/PATCH/PUT"),
    idempotencyKey: z
      .string()
      .max(256)
      .optional()
      .describe("Idempotency-Key header (chat session, chat send, messaging send)"),
  },
  async ({ method, path, query, body, idempotencyKey }) => {
    let key;
    try {
      key = requireApiKey();
    } catch (err) {
      return textResult(err.message, true);
    }

    const url = new URL(path.startsWith("/") ? path : `/${path}`, `${apiBase()}/`);
    if (query) {
      for (const [name, value] of Object.entries(query)) {
        url.searchParams.set(name, String(value));
      }
    }

    const headers = {
      Accept: "application/json",
      "X-Api-Key": key,
    };
    const init = { method, headers };
    if (body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    const res = await fetch(url, init);
    const raw = await res.text();
    let parsed = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw;
    }

    return textResult(
      clip(
        JSON.stringify(
          {
            ok: res.ok,
            status: res.status,
            method,
            url: url.toString(),
            data: parsed,
          },
          null,
          2,
        ),
      ),
      !res.ok,
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
