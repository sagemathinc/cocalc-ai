const assert = require("node:assert/strict");
const { test } = require("node:test");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const {
  UI_VOCABULARY,
  UI_VOCABULARY_ABSENCES,
  UI_VOCABULARY_ALIAS_EXCEPTIONS,
} = require("../dist/ui-vocabulary");

const packagesRoot = join(__dirname, "..", "..");
const sourcesPresent = existsSync(join(packagesRoot, "frontend"));
const skipWithoutSources = sourcesPresent
  ? false
  : "frontend sources are not present next to the docs package";

// Collapse whitespace so formatting changes do not break an anchor. Escapes are
// deliberately not decoded.
function collapse(text) {
  return text.replace(/\s+/g, " ");
}

const cache = new Map();
function read(file) {
  if (!cache.has(file)) {
    const path = join(packagesRoot, file);
    cache.set(
      file,
      existsSync(path) ? collapse(readFileSync(path, "utf8")) : null,
    );
  }
  return cache.get(file);
}

const HOW_TO_FIX =
  "Each failure has one of three causes: the interface renamed or moved the label " +
  "(update the entry in src/ui-vocabulary.ts, then every file in its usedIn list, " +
  "including the support conventions in src/packages/conat/hub/api/admin-support.ts); " +
  "the entry is wrong; or the label is now produced another way (anchor its new definition).";

test("ui vocabulary entries are well formed", () => {
  const ids = new Set();
  for (const entry of UI_VOCABULARY) {
    assert.ok(!ids.has(entry.id), `duplicate vocabulary id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.label, `${entry.id} has no label`);
    assert.ok(entry.anchors.length > 0, `${entry.id} has no source anchor`);
    assert.ok(entry.usedIn.length > 0, `${entry.id} is not used anywhere`);
  }
});

test(
  "every ui vocabulary anchor is present in the interface source",
  { skip: skipWithoutSources },
  () => {
    const failures = [];
    for (const entry of UI_VOCABULARY) {
      for (const anchor of entry.anchors) {
        const text = read(anchor.file);
        if (text == null) {
          failures.push(`${entry.id}: ${anchor.file} does not exist`);
        } else if (!text.includes(collapse(anchor.text))) {
          failures.push(
            `${entry.id} (${entry.label}): ${JSON.stringify(anchor.text)} not found in ${anchor.file} (${anchor.role})`,
          );
        }
      }
    }
    assert.deepEqual(failures, [], `${HOW_TO_FIX}\n${failures.join("\n")}`);
  },
);

test(
  "documentation and support conventions still use each vocabulary label",
  { skip: skipWithoutSources },
  () => {
    const failures = [];
    for (const entry of UI_VOCABULARY) {
      for (const use of entry.usedIn) {
        const text = read(use.file);
        const expected = collapse(use.text ?? entry.label);
        if (text == null) {
          failures.push(`${entry.id}: ${use.file} does not exist`);
        } else if (!text.includes(expected)) {
          failures.push(
            `${entry.id} (${entry.label}): ${JSON.stringify(expected)} not found in ${use.file}`,
          );
        }
      }
    }
    assert.deepEqual(failures, [], `${HOW_TO_FIX}\n${failures.join("\n")}`);
  },
);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function documentationFiles() {
  const files = [];
  for (const dir of ["content", "entries"]) {
    for (const name of readdirSync(join(__dirname, "..", "src", dir))) {
      if (name.endsWith(".ts")) files.push(`docs/src/${dir}/${name}`);
    }
  }
  return files;
}

test("documentation does not use names the interface does not show", () => {
  const failures = [];
  const files = documentationFiles();
  for (const entry of UI_VOCABULARY) {
    for (const alias of entry.aliases ?? []) {
      const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i");
      for (const file of files) {
        const lines = readFileSync(join(packagesRoot, file), "utf8").split(
          "\n",
        );
        lines.forEach((line, index) => {
          if (!pattern.test(line)) return;
          const allowed = UI_VOCABULARY_ALIAS_EXCEPTIONS.some(
            (exception) =>
              exception.file === file && line.includes(exception.line),
          );
          if (!allowed) {
            failures.push(
              `${file}:${index + 1}: "${alias}" is not an interface name; use ${JSON.stringify(entry.label)} (${entry.id})`,
            );
          }
        });
      }
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test(
  "interface facts the support conventions depend on still hold",
  { skip: skipWithoutSources },
  () => {
    const failures = [];
    for (const absence of UI_VOCABULARY_ABSENCES) {
      const text = read(absence.file);
      if (text == null) {
        failures.push(`${absence.id}: ${absence.file} does not exist`);
        continue;
      }
      const start = text.indexOf(collapse(absence.after));
      const end =
        start < 0 ? -1 : text.indexOf(collapse(absence.before), start);
      if (start < 0 || end < 0) {
        failures.push(
          `${absence.id}: could not find the block between ${JSON.stringify(absence.after)} and ${JSON.stringify(absence.before)} in ${absence.file}`,
        );
      } else if (text.slice(start, end).includes(absence.text)) {
        failures.push(
          `${absence.id}: ${absence.text} now appears in ${absence.file}. ${absence.reason}`,
        );
      }
    }
    assert.deepEqual(failures, [], failures.join("\n"));
  },
);

test("the source reader collapses whitespace and does not decode escapes", () => {
  assert.equal(collapse('label:\n    "Files"'), 'label: "Files"');
  // A label written as an escape in source must not match its rendered
  // character, or an unmodelled escape would pass without being compared.
  assert.equal(collapse("\\u2190").includes("\u2190"), false);
});
