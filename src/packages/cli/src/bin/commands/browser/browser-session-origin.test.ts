import assert from "node:assert/strict";
import test from "node:test";

import { browserSessionSiteOrigin } from "./register-session-commands";

// The project host refuses a session bootstrap POST without an approved
// Origin ("cross-site request refused"); the CLI acts for its site.
test("the bootstrap says it comes from the site's public origin", async () => {
  const origin = await browserSessionSiteOrigin({
    apiBaseUrl: "http://localhost:9100",
    hub: {
      system: {
        getPublicSiteUrl: async () => ({ url: "https://lite1b.cocalc.ai/" }),
      },
    },
  });
  assert.equal(origin, "https://lite1b.cocalc.ai");
});

test("without the site URL it falls back to the API address's origin", async () => {
  assert.equal(
    await browserSessionSiteOrigin({
      apiBaseUrl: "https://cocalc.ai/api",
      hub: {
        system: {
          getPublicSiteUrl: async () => {
            throw new Error("unavailable");
          },
        },
      },
    }),
    "https://cocalc.ai",
  );
  assert.equal(
    await browserSessionSiteOrigin({
      apiBaseUrl: "https://cocalc.ai/api",
      hub: { system: {} },
    }),
    "https://cocalc.ai",
  );
});
