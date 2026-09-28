import assert from "node:assert/strict";
import test from "node:test";
import {
  callHubWithApiKey,
  getProjectHostAccessWithApiKey,
  listProjectsWithApiKey,
} from "./api-key-hub";

test("preserves a throttling response without replay or remote private fields", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({
        error: "private server context",
        code: "api_search_rate_limited",
        retry_after_ms: 1250,
        credential: "private",
        stack: "private",
      }),
      { status: 429 },
    );
  }) as typeof fetch;
  try {
    await assert.rejects(
      callHubWithApiKey({
        apiBaseUrl: "https://example.com",
        apiKey: "test-key",
        name: "projects.listProjectSummaries",
        args: [{}],
      }),
      (err: any) => {
        assert.equal(err.code, "api_search_rate_limited");
        assert.equal(err.retry_after_ms, 1250);
        assert.equal(err.message, "API search rate limit exceeded");
        assert.equal(err.credential, undefined);
        assert.notEqual(err.stack, "private");
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("non-JSON 429 responses retain a useful status error", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response("not JSON", { status: 429 })) as typeof fetch;
  try {
    await assert.rejects(
      callHubWithApiKey({
        apiBaseUrl: "https://example.com",
        apiKey: "test-key",
        name: "projects.listProjectSummaries",
        args: [{}],
      }),
      /API request failed \(429\)/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("uses the scoped HTTP bridge without putting the key in the URL or body", async () => {
  const originalFetch = global.fetch;
  const calls: Array<[unknown, RequestInit]> = [];
  global.fetch = (async (url: unknown, opts: RequestInit) => {
    calls.push([url, opts]);
    return {
      ok: true,
      json: async () => ({ projects: [], next_offset: null }),
    } as Response;
  }) as typeof fetch;
  try {
    assert.deepEqual(
      await listProjectsWithApiKey({
        apiBaseUrl: "https://lite2b.cocalc.ai",
        apiKey: "test-secret",
        limit: 20,
        offset: 0,
        search: "Sage",
      }),
      { projects: [], next_offset: null },
    );
    const [url, opts] = calls[0];
    assert.equal(String(url), "https://lite2b.cocalc.ai/api/conat/hub");
    assert.equal(
      (opts.headers as Record<string, string>).Authorization,
      "Bearer test-secret",
    );
    assert.equal(String(opts.body).includes("test-secret"), false);
    assert.deepEqual(JSON.parse(String(opts.body)), {
      name: "projects.listProjectSummaries",
      args: [{ limit: 20, offset: 0, search: "Sage" }],
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("gets project-bound host access with the key only in the header", async () => {
  const originalFetch = global.fetch;
  let request: { url: string; options: RequestInit } | undefined;
  const project_id = "22222222-2222-4222-8222-222222222222";
  global.fetch = (async (url: URL, options: RequestInit) => {
    request = { url: String(url), options };
    return {
      ok: true,
      json: async () => ({
        project_id,
        title: "SageMath",
        host_id: "33333333-3333-4333-8333-333333333333",
        connect_url: "https://host.example.com",
        local_proxy: false,
        token: "child-token",
        expires_at: Date.now() + 20_000,
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const access = await getProjectHostAccessWithApiKey({
      apiBaseUrl: "https://lite2b.cocalc.ai",
      apiKey: "test-secret",
      project_id,
    });
    assert.equal(access.title, "SageMath");
    assert.equal(
      request?.url,
      "https://lite2b.cocalc.ai/api/conat/project-host-api-key",
    );
    assert.equal(
      (request?.options.headers as Record<string, string>).Authorization,
      "Bearer test-secret",
    );
    assert.deepEqual(JSON.parse(String(request?.options.body)), { project_id });
  } finally {
    global.fetch = originalFetch;
  }
});

test("rejects an unexpected API response", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({ users_summary: {} }),
    }) as Response) as typeof fetch;
  try {
    await assert.rejects(
      listProjectsWithApiKey({
        apiBaseUrl: "https://lite2b.cocalc.ai",
        apiKey: "test-secret",
        limit: 20,
        offset: 0,
      }),
      /invalid project list response/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
