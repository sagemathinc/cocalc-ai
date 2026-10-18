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

// The request itself: the bootstrap POST the project host receives must
// carry the site's Origin, or the host refuses it as cross-site.
test("the bootstrap POST reaches the project host with the site's Origin", async () => {
  const http = await import("node:http");
  const { PROJECT_HOST_BROWSER_SESSION_COOKIE_NAME } =
    await import("@cocalc/conat/auth/project-host-browser-session");
  const { resolveProjectHostBrowserSessionCookies } =
    await import("./register-session-commands");
  const seen: { method?: string; origin?: string; auth?: string }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({
      method: req.method,
      origin: req.headers.origin,
      auth: req.headers.authorization,
    });
    res.setHeader(
      "Set-Cookie",
      `${PROJECT_HOST_BROWSER_SESSION_COOKIE_NAME}=cookie-value; Path=/; HttpOnly`,
    );
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(server.address() as any).port}`;
  const saved = process.env.COCALC_CLI_TRANSPORT;
  process.env.COCALC_CLI_TRANSPORT = "direct";
  try {
    const apiBaseUrl = "http://hub.invalid";
    const cookies = await resolveProjectHostBrowserSessionCookies({
      ctx: {
        apiBaseUrl,
        hub: {
          system: {
            getPublicSiteUrl: async () => ({ url: "https://lite1b.cocalc.ai" }),
          },
          hosts: {
            resolveHostConnection: async () => ({ connect_url: address }),
            issueProjectHostAuthToken: async () => ({ token: "host-token" }),
          },
        },
      } as any,
      deps: {
        resolveProject: async () => ({ host_id: "host-1" }),
      } as any,
      project_id: "00000000-0000-4000-8000-000000000001",
    });
    assert.deepEqual(seen, [
      {
        method: "POST",
        origin: "https://lite1b.cocalc.ai",
        auth: "Bearer host-token",
      },
    ]);
    assert.equal(cookies[0]?.value, "cookie-value");
  } finally {
    if (saved == null) delete process.env.COCALC_CLI_TRANSPORT;
    else process.env.COCALC_CLI_TRANSPORT = saved;
    server.close();
  }
});
