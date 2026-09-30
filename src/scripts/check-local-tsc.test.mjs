import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isStaleTscShim, staleTscShims } from "./check-local-tsc.mjs";

const shim = (version) =>
  `#!/bin/sh\nexec node "$basedir/../../node_modules/.pnpm/typescript@${version}/node_modules/typescript/bin/tsc" "$@"\n`;

test("recognizes shims that run TypeScript < 7", () => {
  assert.equal(isStaleTscShim(shim("6.0.3")), true);
  assert.equal(isStaleTscShim(shim("7.0.2")), false);
});

test("finds stale shims in workspace packages", (t) => {
  const root = mkdtempSync(join(tmpdir(), "check-local-tsc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (dir, content) => {
    mkdirSync(join(root, dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, dir, "node_modules", ".bin", "tsc"), content);
  };
  write("", shim("7.0.2"));
  write("lite", shim("6.0.3"));
  write("apps/notebook", shim("7.0.2"));
  write("apps/tasks", shim("6.0.3"));
  assert.deepEqual(staleTscShims(root).sort(), [
    join(root, "apps/tasks/node_modules/.bin/tsc"),
    join(root, "lite/node_modules/.bin/tsc"),
  ]);
});
