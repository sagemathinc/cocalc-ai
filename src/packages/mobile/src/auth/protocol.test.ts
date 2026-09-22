/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseProtocolCompatibility } from "./protocol";

const compatible = {
  protocol_version: 1 as const,
  app_base_path: "",
  browser_challenge_login: 1 as const,
  project_window: 1 as const,
  project_host_routing: 1 as const,
  chat_sync: 2 as const,
  agent_session_index: 1 as const,
  acp: 1 as const,
};

test("accepts the advertised native protocol", () => {
  assert.deepEqual(
    parseProtocolCompatibility({ client_capabilities: compatible }),
    { capabilities: compatible, legacy: false },
  );
});

test("makes an explicit legacy-server fallback", () => {
  const result = parseProtocolCompatibility({ signed_in: false });
  assert.equal(result.legacy, true);
  assert.match(result.warning ?? "", /predates native-client/);
});

test("reports a server upgrade for an incompatible chat schema", () => {
  assert.throws(
    () =>
      parseProtocolCompatibility({
        client_capabilities: { ...compatible, chat_sync: 1 },
      }),
    /server upgrade is required/i,
  );
});

test("native API requests use explicit profile cookies without the platform cookie jar", async () => {
  const { postSiteApi } = await import("./protocol");
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(options ?? {});
    return new Response(JSON.stringify({ signed_in: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const site = {
      entered_app_url: "https://example.com",
      canonical_app_url: "https://example.com",
      origin: "https://example.com",
      app_base_path: "",
    };
    await postSiteApi({
      site,
      endpoint: "auth/bootstrap",
      body: {},
      cookieHeader: "remember_me=test-profile-session",
    });
    await postSiteApi({ site, endpoint: "auth/bootstrap", body: {} });
    assert.equal(requests[0].credentials, "omit");
    assert.equal(
      (requests[0].headers as Record<string, string>).Cookie,
      "remember_me=test-profile-session",
    );
    assert.equal(requests[1].credentials, "omit");
    assert.equal(
      (requests[1].headers as Record<string, string>).Cookie,
      undefined,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("session confirmation retries a network failure once", async () => {
  const { getAuthBootstrap } = await import("./protocol");
  const { normalizeSiteUrl } = await import("./site-url");
  const before = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) throw new TypeError("Network request failed");
    return new Response(JSON.stringify({ signed_in: true }));
  };
  try {
    assert.equal(
      (
        await getAuthBootstrap({
          site: normalizeSiteUrl("https://cocalc.test"),
        })
      ).signed_in,
      true,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = before;
  }
});

test("session confirmation does not retry an authentication rejection", async () => {
  const { getAuthBootstrap } = await import("./protocol");
  const { normalizeSiteUrl } = await import("./site-url");
  const before = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  };
  try {
    await assert.rejects(
      getAuthBootstrap({ site: normalizeSiteUrl("https://cocalc.test") }),
      /Unauthorized/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = before;
  }
});
