import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_HOST_API_KEY_HTTP_HEADER } from "@cocalc/conat/auth/project-host-http";
import {
  requestScopedProjectProxy,
  resolveScopedProxyUrl,
} from "./scoped-project-proxy";

const options = {
  apiBaseUrl: "https://hub.example",
  apiKey: "parent-secret",
  project_id: "22222222-2222-4222-8222-222222222222",
  port: 8080,
  timeoutMs: 5000,
};
const exchange = {
  project_id: options.project_id,
  title: "test",
  host_id: "33333333-3333-4333-8333-333333333333",
  connect_url: "wss://host.example",
  local_proxy: false,
  token: "child-secret",
  expires_at: Date.now() + 25_000,
};

test("scoped proxy uses separate credentials, no cookies, and manual redirects", async () => {
  const original = global.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  global.fetch = (async (url: any, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return calls.length === 1
      ? Response.json(exchange)
      : new Response("app reply", {
          status: 302,
          headers: { Location: "https://other.example" },
        });
  }) as typeof fetch;
  try {
    const result = await requestScopedProjectProxy({
      ...options,
      path: "/hello?q=1",
    });
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      project_id: options.project_id,
      http_proxy_port: 8080,
    });
    assert.deepEqual(calls[1].init.headers, {
      [PROJECT_HOST_API_KEY_HTTP_HEADER]: "child-secret",
    });
    assert.equal(calls[1].init.redirect, "manual");
    assert.equal(
      calls[1].url,
      `https://host.example/${options.project_id}/proxy/8080/hello?q=1`,
    );
    assert.equal(result.status, 302);
    assert.equal(result.body_preview, "app reply");
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = original;
  }
});

test("proxy URL output contains no scoped credential", async () => {
  const original = global.fetch;
  global.fetch = (async () => Response.json(exchange)) as typeof fetch;
  try {
    assert.deepEqual(await resolveScopedProxyUrl(options), {
      project_id: options.project_id,
      host_id: exchange.host_id,
      local_proxy: false,
      url: `https://host.example/${options.project_id}/proxy/8080/`,
    });
  } finally {
    global.fetch = original;
  }
});

test("rejects host and port overrides and normalized path escapes without sending the child", async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = (async () => {
    calls++;
    return Response.json(exchange);
  }) as typeof fetch;
  try {
    await assert.rejects(
      resolveScopedProxyUrl({ ...options, hostIdentifier: "another-host" }),
      /host override/,
    );
    await assert.rejects(
      resolveScopedProxyUrl({ ...options, port: 0 }),
      /port must/,
    );
    assert.equal(calls, 0);
    for (const path of [
      "../9090/",
      "%2e%2e/9090/",
      "https://other.example/",
      "\\\\other.example/x",
    ]) {
      const before = calls;
      await assert.rejects(
        requestScopedProjectProxy({ ...options, path }),
        /within the selected/,
      );
      assert.equal(calls, before + 1);
    }
  } finally {
    global.fetch = original;
  }
});

test("denied exchange does not fall back to another credential", async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = (async () => {
    calls++;
    return Response.json({ error: "revoked" });
  }) as typeof fetch;
  try {
    await assert.rejects(requestScopedProjectProxy(options), /revoked/);
    assert.equal(calls, 1);
  } finally {
    global.fetch = original;
  }
});

test("bounds preview reading and cancels a continuing response", async () => {
  const original = global.fetch;
  let calls = 0;
  let canceled = false;
  global.fetch = (async () => {
    if (++calls === 1) return Response.json(exchange);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(2048)));
        },
        cancel() {
          canceled = true;
        },
      }),
    );
  }) as typeof fetch;
  try {
    assert.equal(
      (await requestScopedProjectProxy(options)).body_preview.length,
      1024,
    );
    assert.equal(canceled, true);
  } finally {
    global.fetch = original;
  }
});
