import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BASELINE,
  compare,
  countSinks,
  repoRoot,
  scanTrackedFiles,
} from "./check-html-sinks.mjs";

test("counts each sink kind", () => {
  const text = [
    "<div dangerouslySetInnerHTML={{ __html: x }} />",
    "el.innerHTML = s; el.outerHTML += t;",
    "el.insertAdjacentHTML('beforeend', s);",
    "w.document.write(s); document.writeln(s);",
    "<iframe srcDoc={s} /> f.srcdoc = s;",
    "range.createContextualFragment(s);",
    "render({ noSanitize: true });",
  ].join("\n");
  assert.deepEqual(countSinks(text), {
    dangerouslySetInnerHTML: 1,
    "innerHTML assignment": 2,
    insertAdjacentHTML: 1,
    "document.write": 2,
    srcDoc: 2,
    createContextualFragment: 1,
    noSanitize: 1,
  });
});

test("ignores reads, comparisons and comments", () => {
  const text = [
    "const s = el.innerHTML;",
    "if (el.innerHTML == s || el.innerHTML === t) {}",
    "// never use dangerouslySetInnerHTML here",
    " * noSanitize is gone",
    "/* el.innerHTML = s */",
  ].join("\n");
  assert.deepEqual(countSinks(text), {});
});

test("reports increases and unrecorded decreases", () => {
  assert.deepEqual(
    compare({ "a.ts": { srcDoc: 1 } }, { "a.ts": { srcDoc: 1 } }),
    [],
  );
  assert.deepEqual(compare({}, { "b.tsx": { noSanitize: 2 } }), [
    "b.tsx: 2 new noSanitize (baseline 0)",
  ]);
  assert.match(
    compare({ "a.ts": { srcDoc: 2 } }, { "a.ts": { srcDoc: 1 } })[0],
    /1 fewer srcDoc .*--update/,
  );
});

test("the repository matches the baseline", () => {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  assert.deepEqual(compare(baseline, scanTrackedFiles(repoRoot())), []);
});
