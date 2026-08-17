import assert from "node:assert/strict";
import test from "node:test";

import { resolveConatAddress } from "./conat-address";

test("an explicit site target overrides project-local transport", () => {
  assert.equal(
    resolveConatAddress({
      apiBaseUrl: "https://staging.cocalc.ai",
      conatServer: "http://10.206.0.1:9102",
      preferApiTransport: true,
    }),
    "https://staging.cocalc.ai",
  );
});

test("ambient project commands retain project-local transport", () => {
  assert.equal(
    resolveConatAddress({
      apiBaseUrl: "http://alpha.c.projecthosts.internal:9102",
      conatServer: "http://10.206.0.1:9102",
    }),
    "http://10.206.0.1:9102",
  );
});

test("public API targets ignore stale loopback transports", () => {
  assert.equal(
    resolveConatAddress({
      apiBaseUrl: "https://cocalc.ai",
      conatServer: "http://127.0.0.1:9102",
    }),
    "https://cocalc.ai",
  );
});
