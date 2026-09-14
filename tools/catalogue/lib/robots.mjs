/**
 * Minimal robots.txt reader for User-agent: * rules.
 * Longer Disallow/Allow prefix wins; Allow wins ties.
 */
export function parseRobots(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);

  const groups = [];
  let current = null;
  for (const line of lines) {
    const [rawField, ...rest] = line.split(":");
    if (!rawField || rest.length === 0) continue;
    const field = rawField.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (field === "user-agent") {
      current = { agents: [value.toLowerCase()], allow: [], disallow: [], crawlDelay: null };
      groups.push(current);
      continue;
    }
    if (!current) continue;
    if (field === "allow") current.allow.push(value);
    if (field === "disallow") current.disallow.push(value);
    if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n)) current.crawlDelay = n;
    }
  }

  const star = groups.find((g) => g.agents.includes("*")) ?? {
    allow: [],
    disallow: [],
    crawlDelay: null,
  };
  return star;
}

export function isAllowed(rules, pathname) {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  let verdict = true;
  let best = -1;

  const consider = (pattern, allowed) => {
    if (!pattern) return;
    const prefix = pattern.replace(/\$$/, "").replace(/\*$/, "");
    if (!path.startsWith(prefix) && path !== prefix) return;
    if (prefix.length < best) return;
    best = prefix.length;
    verdict = allowed;
  };

  for (const rule of rules.disallow) consider(rule, false);
  for (const rule of rules.allow) consider(rule, true);
  return verdict;
}
