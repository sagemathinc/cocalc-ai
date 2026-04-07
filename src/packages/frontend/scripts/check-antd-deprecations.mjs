#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const FAIL_ON_FINDINGS = process.argv.includes("--fail-on-findings");

const IGNORE_DIRS = new Set(["node_modules", "dist", ".git"]);

const RULES = [
  {
    id: "space-direction",
    component: "Space",
    message: "[antd: Space] `direction` is deprecated. Use `orientation`.",
    tagPattern: (name) =>
      new RegExp(`<\\s*${escapeRegExp(name)}(?:\\.Compact)?\\b`, "g"),
    prop: "direction",
  },
  {
    id: "input-number-addon-after",
    component: "InputNumber",
    message:
      "[antd: InputNumber] `addonAfter` is deprecated. Use `Space.Compact`.",
    tagPattern: (name) => new RegExp(`<\\s*${escapeRegExp(name)}\\b`, "g"),
    prop: "addonAfter",
  },
  {
    id: "input-number-addon-before",
    component: "InputNumber",
    message:
      "[antd: InputNumber] `addonBefore` is deprecated. Use `Space.Compact`.",
    tagPattern: (name) => new RegExp(`<\\s*${escapeRegExp(name)}\\b`, "g"),
    prop: "addonBefore",
  },
  {
    id: "button-group",
    component: "Button",
    message: "[antd: Button.Group] `Button.Group` is deprecated.",
    pattern: (name) => new RegExp(`<\\s*${escapeRegExp(name)}\\.Group\\b`, "g"),
  },
  {
    id: "tabs-popup-class-name",
    component: "Tabs",
    message:
      "[antd: Tabs] `popupClassName` is deprecated. Use `classNames.popup`.",
    tagPattern: (name) => new RegExp(`<\\s*${escapeRegExp(name)}\\b`, "g"),
    prop: "popupClassName",
  },
  {
    id: "modal-destroy-on-close",
    component: "Modal",
    message:
      "[antd: Modal] `destroyOnClose` is deprecated. Use `destroyOnHidden`.",
    tagPattern: (name) => new RegExp(`<\\s*${escapeRegExp(name)}\\b`, "g"),
    prop: "destroyOnClose",
  },
  {
    id: "drawer-destroy-on-close",
    component: "Drawer",
    message:
      "[antd: Drawer] `destroyOnClose` is deprecated. Use `destroyOnHidden`.",
    tagPattern: (name) => new RegExp(`<\\s*${escapeRegExp(name)}\\b`, "g"),
    prop: "destroyOnClose",
  },
  {
    id: "alert-message",
    component: "Alert",
    message: "[antd: Alert] `message` is deprecated. Use `title`.",
    tagPattern: (name) => new RegExp(`<\\s*${escapeRegExp(name)}\\b`, "g"),
    prop: "message",
  },
];

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listSourceFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      out.push(...(await listSourceFiles(full)));
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    out.push(full);
  }
  return out;
}

function parseAntdImports(content) {
  const imports = new Map();
  const re = /import(?:\s+type)?\s*\{([\s\S]*?)\}\s*from\s*["']antd["']/g;
  let m;
  while ((m = re.exec(content)) != null) {
    const raw = m[1];
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      const aliasMatch = p.match(
        /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/,
      );
      const canonical = aliasMatch ? aliasMatch[1] : p;
      const local = aliasMatch ? aliasMatch[2] : p;
      if (!imports.has(canonical)) {
        imports.set(canonical, new Set());
      }
      imports.get(canonical).add(local);
    }
  }
  return imports;
}

function lineStartsFor(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineFromIndex(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= index) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hi + 1;
}

function lineText(content, starts, lineNumber) {
  const start = starts[lineNumber - 1] ?? 0;
  const end = starts[lineNumber] ?? content.length;
  return content.slice(start, end).trim();
}

function hasPropInOpeningTag(content, startIndex, prop) {
  let i = startIndex;
  let depth = 0;
  let quote = null;
  while (i < content.length) {
    const ch = content[i];
    if (quote != null) {
      if (ch === "\\" && i + 1 < content.length) {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (ch === ">" && depth === 0) {
      const tag = content.slice(startIndex, i);
      return new RegExp(`\\b${escapeRegExp(prop)}\\s*=`).test(tag);
    }
    i += 1;
  }
  return false;
}

async function main() {
  const files = await listSourceFiles(ROOT);
  const findings = [];

  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    const imports = parseAntdImports(content);
    if (imports.size === 0) continue;
    const starts = lineStartsFor(content);

    for (const rule of RULES) {
      const locals = imports.get(rule.component);
      if (locals == null || locals.size === 0) continue;
      for (const local of locals) {
        const re = rule.tagPattern?.(local) ?? rule.pattern(local);
        let m;
        while ((m = re.exec(content)) != null) {
          if (rule.prop && !hasPropInOpeningTag(content, m.index, rule.prop)) {
            continue;
          }
          const line = lineFromIndex(starts, m.index);
          findings.push({
            file: path.relative(ROOT, file),
            line,
            id: rule.id,
            message: rule.message,
            snippet: lineText(content, starts, line),
          });
        }
      }
    }
  }

  findings.sort((a, b) =>
    a.file === b.file
      ? a.line === b.line
        ? a.id.localeCompare(b.id)
        : a.line - b.line
      : a.file.localeCompare(b.file),
  );

  if (findings.length === 0) {
    console.log("No deprecated antd patterns found.");
    return;
  }

  console.log(`Found ${findings.length} deprecated antd usage(s):`);
  for (const f of findings) {
    console.log(`- ${f.file}:${f.line} [${f.id}] ${f.message}`);
    if (f.snippet) {
      console.log(`  ${f.snippet}`);
    }
  }

  if (FAIL_ON_FINDINGS) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
