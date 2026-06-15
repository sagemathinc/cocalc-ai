import assert from "node:assert/strict";
import test from "node:test";

import { resolveDefaultSoftwareR2ModulePath } from "./remote-store";

test("software R2 loader resolves backend helper from source checkout", () => {
  assert.match(
    resolveDefaultSoftwareR2ModulePath(`${process.cwd()}/src`),
    /packages\/backend\/dist\/r2\.js$/,
  );
});
