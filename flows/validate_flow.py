#!/usr/bin/env python3
"""
Validates an Activepieces flow JSON against every import rule that has caused a
real "Template file is invalid" failure. Run before delivering ANY flow file.

Vendored from AC-Group2/agenticflow-studio (.claude/skills/activepieces-flow-builder).
One change: {{variables[...]}} refs are allowed (proven live in this workspace).

Usage: python3 validate_flow.py Flow_X.json [Flow_Y.json ...]
Exit code 0 = all files clean.
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile

REQUIRED_TOP = ["name", "type", "summary", "description", "tags", "blogUrl",
                "metadata", "author", "categories", "pieces", "flows", "status"]
REQUIRED_STEP = ["name", "type", "valid", "displayName", "lastUpdatedDate", "settings"]
REQUIRED_ERRH = ["retryOnFailure", "continueOnFailure"]

FORBIDDEN_CODE = [
    (r"\bfetch\s*\(", "fetch() - isolated-vm has no network access"),
    (r"\brequire\s*\(", "require() - no npm packages in isolated-vm"),
    (r"\bimport\s+.+\bfrom\b", "import ... from - no npm packages in isolated-vm"),
    (r"\bprocess\.", "process.* - no Node APIs in isolated-vm"),
    (r"\bBuffer\b", "Buffer - no Node APIs in isolated-vm"),
]


def walk(node, steps):
    if not isinstance(node, dict):
        return
    steps.append(node)
    for k in ("nextAction", "firstLoopAction"):
        if k in node:
            walk(node[k], steps)
    for ch in node.get("children") or []:
        walk(ch, steps)


def check(fname):
    problems = []
    try:
        data = json.load(open(fname, encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        return [f"not valid JSON: {e}"]

    # wrapper
    for k in REQUIRED_TOP:
        if k not in data:
            problems.append(f"wrapper: missing top-level key '{k}' (SHARED format required)")
    if "template" in data:
        problems.append("wrapper: uses the {'template': ...} format - the server needs the "
                        "SHARED wrapper with flows[]")
    if not data.get("flows"):
        return problems + ["wrapper: no flows[] array"]

    fl = data["flows"][0]
    if str(fl.get("schemaVersion")) != "22":
        problems.append(f"flow: schemaVersion is {fl.get('schemaVersion')!r}, expected '22'")

    steps = []
    walk(fl.get("trigger", {}), steps)
    if not steps:
        return problems + ["flow: no trigger found"]

    # trigger rule
    trig = steps[0]
    tset = trig.get("settings", {})
    if tset.get("pieceName") != "@activepieces/piece-manual-trigger":
        problems.append(f"trigger: first piece is {tset.get('pieceName')!r} - must be "
                        "@activepieces/piece-manual-trigger (swap to webhook/cron in the UI "
                        "AFTER import)")

    names = set()
    for s in steps:
        sid = s.get("name", "?")
        names.add(sid)
        for k in REQUIRED_STEP:
            if k not in s:
                problems.append(f"step {sid}: missing key '{k}'")
        if s.get("type") != "PIECE_TRIGGER" and "skip" not in s:
            problems.append(f"step {sid}: missing key 'skip'")
        st = s.get("settings", {})
        if "sampleData" not in st:
            problems.append(f"step {sid}: settings missing 'sampleData'")
        if "propertySettings" not in st and s.get("type") != "ROUTER":
            problems.append(f"step {sid}: settings missing 'propertySettings'")
        if s.get("type") in ("PIECE", "CODE"):
            eh = st.get("errorHandlingOptions", {})
            for k in REQUIRED_ERRH:
                if k not in eh:
                    problems.append(f"step {sid}: errorHandlingOptions missing '{k}'")
        # code-step content rules
        if s.get("type") == "CODE":
            code = st.get("sourceCode", {}).get("code", "")
            if "export const code" not in code:
                problems.append(f"step {sid}: code must define 'export const code = async (inputs) => ...'")
            for pattern, msg in FORBIDDEN_CODE:
                if re.search(pattern, code):
                    problems.append(f"step {sid}: code uses {msg}")
            if shutil.which("node"):
                with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as tf:
                    tf.write(code.replace("export const code", "const code"))
                    path = tf.name
                r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
                if r.returncode != 0:
                    problems.append(f"step {sid}: JS syntax error: {r.stderr.splitlines()[-1][:120]}")
        if s.get("type") == "LOOP_ON_ITEMS" and "items" not in s.get("settings", {}):
            problems.append(f"step {sid}: loop missing settings.items")

    # reference targets exist
    refs = set(re.findall(r"\{\{(\w+)\[", json.dumps(data)))
    missing = refs - names - {"trigger", "connections", "variables"}  # amira: workspace variables are valid on this instance
    for m in missing:
        problems.append(f"reference: {{{{{m}[...]}}}} points to a step that does not exist")

    # secrets heuristic
    raw = json.dumps(data)
    for pat, what in [(r"sk-ant-[A-Za-z0-9\-]{10,}", "Anthropic API key"),
                      (r"1000\.[0-9a-f]{20,}\.[0-9a-f]{10,}", "Zoho token/secret")]:
        if re.search(pat, raw):
            problems.append(f"SECRET: file appears to contain a real {what} - replace with YOUR_* placeholder")

    return problems


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    failed = False
    for fname in sys.argv[1:]:
        problems = check(fname)
        if problems:
            failed = True
            print(f"FAIL {fname}")
            for p in problems:
                print(f"   - {p}")
        else:
            print(f"OK   {fname}")
    sys.exit(1 if failed else 0)
