// A ratchet on places that turn strings into live HTML (dangerouslySetInnerHTML,
// innerHTML assignment, document.write, srcDoc, the noSanitize option, ...).
// Each one is a spot where unsanitized content could run as the user, so new
// ones must be added deliberately: the counts per file and kind must equal
// html-sinks-baseline.json exactly. A new sink fails the check, and so does a
// removed one until the baseline is updated, so the counts can only go down
// without anyone noticing.
//
//   node scripts/check-html-sinks.mjs            check
//   node scripts/check-html-sinks.mjs --update   rewrite the baseline
//
// Prefer the sanitized renderers (components/sanitize-html.ts) or a sandboxed
// iframe over adding a sink. Test files are not scanned.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SINKS = [
  ["dangerouslySetInnerHTML", /\bdangerouslySetInnerHTML\b/g],
  ["innerHTML assignment", /\.(?:inner|outer)HTML\s*\+?=(?!=)/g],
  ["insertAdjacentHTML", /\.insertAdjacentHTML\s*\(/g],
  ["document.write", /\bdocument\s*\.\s*write(?:ln)?\s*\(/g],
  ["srcDoc", /\bsrc[dD]oc\s*=/g],
  ["createContextualFragment", /\.createContextualFragment\s*\(/g],
  ["noSanitize", /\bnoSanitize\b/g],
];

const SOURCE = /\.(?:[cm]?js|jsx|ts|tsx)$/;
const SKIP =
  /(?:^|\/)(?:node_modules|dist|build|__tests__|test|tests)\/|\.test\.[^/]+$|\.d\.ts$|\.min\.js$/;

export const BASELINE = fileURLToPath(
  new URL("./html-sinks-baseline.json", import.meta.url),
);

// Comment lines are ignored, so prose that mentions a sink doesn't count.
export function countSinks(text) {
  const counts = {};
  for (const line of text.split("\n")) {
    const t = line.trimStart();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    for (const [kind, re] of SINKS) {
      const n = line.match(re)?.length ?? 0;
      if (n) counts[kind] = (counts[kind] ?? 0) + n;
    }
  }
  return counts;
}

export function scanTrackedFiles(root) {
  const files = execFileSync("git", ["ls-files", "-z", "src/packages"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter((f) => f && SOURCE.test(f) && !SKIP.test(f));
  const result = {};
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const counts = countSinks(text);
    if (Object.keys(counts).length) result[file] = counts;
  }
  return result;
}

export function compare(baseline, current) {
  const problems = [];
  const files = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const file of [...files].sort()) {
    const kinds = new Set([
      ...Object.keys(baseline[file] ?? {}),
      ...Object.keys(current[file] ?? {}),
    ]);
    for (const kind of [...kinds].sort()) {
      const was = baseline[file]?.[kind] ?? 0;
      const now = current[file]?.[kind] ?? 0;
      if (now > was)
        problems.push(`${file}: ${now - was} new ${kind} (baseline ${was})`);
      else if (now < was)
        problems.push(
          `${file}: ${was - now} fewer ${kind} than the baseline; run with --update to lock in the reduction`,
        );
    }
  }
  return problems;
}

function sorted(scan) {
  const out = {};
  for (const file of Object.keys(scan).sort()) {
    out[file] = {};
    for (const kind of Object.keys(scan[file]).sort())
      out[file][kind] = scan[file][kind];
  }
  return out;
}

export function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const current = scanTrackedFiles(repoRoot());
  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, JSON.stringify(sorted(current), null, 2) + "\n");
    console.log(`Wrote ${BASELINE}`);
    process.exit(0);
  }
  const problems = compare(JSON.parse(readFileSync(BASELINE, "utf8")), current);
  if (problems.length) {
    console.error(
      `HTML sink counts differ from scripts/html-sinks-baseline.json:\n${problems.join("\n")}\n\n` +
        "Prefer the sanitized renderers or a sandboxed iframe over a new sink. " +
        "If one is really needed, explain why in the PR and run " +
        "node scripts/check-html-sinks.mjs --update.",
    );
    process.exit(1);
  }
  console.log("HTML sink counts match the baseline.");
}
