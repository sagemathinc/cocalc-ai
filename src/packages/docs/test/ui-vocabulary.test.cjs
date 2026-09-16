const assert = require("node:assert/strict");
const { test } = require("node:test");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const {
  UI_VOCABULARY,
  UI_VOCABULARY_FACTS,
  UI_VOCABULARY_ALIAS_EXCEPTIONS,
} = require("../dist/ui-vocabulary");

const packagesRoot = join(__dirname, "..", "..");
const sourcesPresent = existsSync(join(packagesRoot, "frontend"));
// Outside CI, allow running the docs package on its own. In CI a missing
// source tree must fail, because a skipped check reports green.
const skipWithoutSources =
  sourcesPresent || process.env.CI
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

function skipString(text, index) {
  const quote = text[index];
  for (let i = index + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return text.length;
}

// The definition that carries a message id: from the nearest `{` or `<` before
// the id to the `}` or `/>` that closes it. String contents are skipped, so an
// ICU placeholder such as "{projectLabel} Activity Log" does not end it early.
// This covers defineMessage and formatMessage objects as well as
// <FormattedMessage id=... /> elements.
function messageDefinition(text, messageId) {
  const at = text.indexOf(`"${messageId}"`);
  if (at < 0) return null;
  const start = Math.max(text.lastIndexOf("{", at), text.lastIndexOf("<", at));
  if (start < 0) return null;
  let depth = 0;
  for (let i = at + messageId.length + 2; i < text.length; i++) {
    const char = text[i];
    if (char === '"' || char === "'" || char === "`") {
      i = skipString(text, i);
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      if (depth === 0) return text.slice(start, i + 1);
      depth--;
    } else if (char === "/" && text[i + 1] === ">" && depth === 0) {
      return text.slice(start, i + 2);
    }
  }
  return null;
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
        const where = `${entry.id} (${entry.label}): ${JSON.stringify(anchor.text)}`;
        if (text == null) {
          failures.push(`${entry.id}: ${anchor.file} does not exist`);
        } else if (anchor.messageId != null) {
          const definition = messageDefinition(text, anchor.messageId);
          if (definition == null) {
            failures.push(
              `${entry.id} (${entry.label}): message ${anchor.messageId} not found in ${anchor.file}`,
            );
          } else if (!definition.includes(collapse(anchor.text))) {
            failures.push(
              `${where} not found in message ${anchor.messageId} in ${anchor.file}`,
            );
          }
        } else if (!text.includes(collapse(anchor.text))) {
          failures.push(
            `${where} not found in ${anchor.file} (${anchor.role})`,
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
    for (const fact of UI_VOCABULARY_FACTS) {
      const text = read(fact.file);
      const target = collapse(fact.text);
      if (text == null) {
        failures.push(
          `${fact.id}: ${fact.file} does not exist. ${fact.reason}`,
        );
      } else if (fact.kind === "present") {
        if (!text.includes(target)) {
          failures.push(
            `${fact.id}: ${JSON.stringify(fact.text)} is no longer in ${fact.file}. ${fact.reason}`,
          );
        }
      } else {
        const start = text.indexOf(collapse(fact.after ?? ""));
        const end =
          start < 0 ? -1 : text.indexOf(collapse(fact.before ?? ""), start);
        if (start < 0 || end < 0) {
          failures.push(
            `${fact.id}: could not find the block between ${JSON.stringify(fact.after)} and ${JSON.stringify(fact.before)} in ${fact.file}`,
          );
        } else if (text.slice(start, end).includes(target)) {
          failures.push(
            `${fact.id}: ${fact.text} now appears in ${fact.file}. ${fact.reason}`,
          );
        }
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

test("a message anchor reads only its own definition", () => {
  const source = collapse(`
    files: { id: "labels.files", defaultMessage: "Files" },
    explorer: {
      id: "labels.explorer",
      description: "added later",
      defaultMessage: "Explorer",
    },
    <FormattedMessage id="page.title" defaultMessage="Recent Files" />
    <FormattedMessage
      id="page.activity"
      defaultMessage="{projectLabel} Activity Log"
      values={{ projectLabel }}
    />
  `);
  assert.ok(
    messageDefinition(source, "page.activity").includes(
      'defaultMessage="{projectLabel} Activity Log"',
    ),
  );
  const explorer = messageDefinition(source, "labels.explorer");
  assert.ok(explorer.includes('defaultMessage: "Explorer"'));
  assert.equal(explorer.includes('defaultMessage: "Files"'), false);
  assert.ok(
    messageDefinition(source, "page.title").includes(
      'defaultMessage="Recent Files"',
    ),
  );
  assert.equal(messageDefinition(source, "labels.missing"), null);
});
