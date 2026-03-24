import assert from "node:assert/strict";
import test from "node:test";

import { loadScriptModule, resolveScriptHandler } from "./script-runner";

test("resolveScriptHandler accepts default exported async function", async () => {
  const moduleExports = await loadScriptModule({
    filename: "/tmp/notebook-runner.test.ts",
    source: `
      export default async function ({ value }: { value: number }) {
        return value + 1;
      }
    `,
  });
  const handler = resolveScriptHandler(moduleExports);
  const result = await handler({ value: 4 });
  assert.equal(result, 5);
});

test("loadScriptModule strips type-only imports", async () => {
  const moduleExports = await loadScriptModule({
    filename: "/tmp/notebook-runner-type-import.test.ts",
    source: `
      import type { ProjectJupyterExecContext } from "@cocalc/cli/api/jupyter-script";

      export default async function (ctx: ProjectJupyterExecContext) {
        return ctx.path;
      }
    `,
  });
  const handler = resolveScriptHandler(moduleExports);
  const result = await handler({ path: "demo.ipynb" });
  assert.equal(result, "demo.ipynb");
});

test("loadScriptModule accepts JavaScript default exports", async () => {
  const moduleExports = await loadScriptModule({
    filename: "/tmp/notebook-runner.js",
    source: `
      export default async function ({ value }) {
        return value * 2;
      }
    `,
  });
  const handler = resolveScriptHandler(moduleExports);
  const result = await handler({ value: 6 });
  assert.equal(result, 12);
});

test("resolveScriptHandler rejects modules without a callable export", () => {
  assert.throws(
    () => resolveScriptHandler({ default: 5 }),
    /script must export a function/,
  );
});
