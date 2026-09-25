import assert from "node:assert/strict";
import test from "node:test";
import { listProjectsWithApiKey } from "./api-key-hub";

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
