import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildCookieHeader } from "./auth-cookies";
import {
  projectApiRelayTransport,
  fetchWithProjectApiRelay,
  selectProjectApiRelayTransport,
  apiTransportMode,
} from "./api-relay";
import {
  API_RELAY_PATH,
  API_RELAY_PROJECT_HEADER,
  API_RELAY_SECRET_HEADER,
  API_RELAY_HUB_HEADER,
} from "@cocalc/conat/project-host/api-relay";

const projectId = "11111111-1111-4111-8111-111111111111";
const env: NodeJS.ProcessEnv = {
  COCALC_API_RELAY: "1",
  COCALC_API_RELAY_HUB_URL: "https://site.example/site",
  COCALC_PROJECT_ID: projectId,
  COCALC_PROJECT_SECRET: "local-secret",
  CONAT_SERVER: "http://10.206.0.1:9102/",
};

test("relay transport preserves the requested API endpoint for host-side allowlist validation", () => {
  assert.equal(
    projectApiRelayTransport({
      env: {},
      apiBaseUrl: env.COCALC_API_RELAY_HUB_URL!,
    }),
    undefined,
  );
  assert.deepEqual(
    projectApiRelayTransport({
      env,
      apiBaseUrl: env.COCALC_API_RELAY_HUB_URL!,
    }),
    {
      address: `http://10.206.0.1:9102${API_RELAY_PATH}/hub`,
      extraHeaders: {
        [API_RELAY_PROJECT_HEADER]: projectId,
        [API_RELAY_SECRET_HEADER]: "local-secret",
        [API_RELAY_HUB_HEADER]: "https://site.example/site",
      },
    },
  );
  assert.equal(
    projectApiRelayTransport({
      env,
      apiBaseUrl: "https://home-bay.example/site",
    })?.extraHeaders[API_RELAY_HUB_HEADER],
    "https://home-bay.example/site",
  );
});

test("host relay URLs carry identifiers, never a caller-chosen upstream", () => {
  const host = {
    host_id: "22222222-2222-4222-8222-222222222222",
    project_id: projectId,
  };
  const result = projectApiRelayTransport({
    env,
    apiBaseUrl: env.COCALC_API_RELAY_HUB_URL!,
    host,
  });
  assert.equal(
    result?.address,
    `http://10.206.0.1:9102${API_RELAY_PATH}/host/${host.host_id}/${host.project_id}`,
  );
});

test("a configured relay fails explicitly without its local project credential", () => {
  assert.throws(
    () =>
      projectApiRelayTransport({
        env: { ...env, COCALC_PROJECT_SECRET: "" },
        apiBaseUrl: env.COCALC_API_RELAY_HUB_URL!,
      }),
    /requires/,
  );
});

test("HTTP transport retains canonical paths and original credentials and rejects redirects", async () => {
  const saved = { ...process.env };
  const seen: Array<{
    url?: string;
    authorization?: string;
    secret?: string;
    hub?: string;
  }> = [];
  const server = createServer((req, res) => {
    seen.push({
      url: req.url,
      authorization: req.headers.authorization,
      secret: req.headers[API_RELAY_SECRET_HEADER] as string,
      hub: req.headers[API_RELAY_HUB_HEADER] as string,
    });
    if (req.url?.endsWith("redirect")) {
      res.writeHead(302, { Location: "https://forbidden.invalid/" }).end();
    } else res.end("ok");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    Object.assign(process.env, env, {
      CONAT_SERVER: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    const response = await fetchWithProjectApiRelay(
      "https://site.example/site/api/v2/auth/status?check=1",
      { headers: { Authorization: "Bearer caller" } },
    );
    assert.equal(await response.text(), "ok");
    assert.deepEqual(seen[0], {
      url: `${API_RELAY_PATH}/hub/api/v2/auth/status?check=1`,
      authorization: "Bearer caller",
      secret: "local-secret",
      hub: "https://site.example/site",
    });
    await assert.rejects(
      fetchWithProjectApiRelay("https://site.example/site/api/v2/redirect"),
      /refused an HTTP redirect/,
    );
    assert.equal(seen.length, 2);
    const bayResponse = await fetchWithProjectApiRelay(
      "https://home-bay.example/site/api/v2/auth/status",
    );
    assert.equal(await bayResponse.text(), "ok");
    assert.equal(seen[2].hub, "https://home-bay.example/site");
    assert.equal(seen[2].url, `${API_RELAY_PATH}/hub/api/v2/auth/status`);
    assert.equal(seen.length, 4); // HEAD probe, then the actual request.
  } finally {
    for (const name of Object.keys(process.env))
      if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("direct override requires no project secret and invalid modes fail", async () => {
  assert.equal(
    await selectProjectApiRelayTransport({
      apiBaseUrl: "https://prod.test",
      credentialSite: "https://prod.test",
      env: { COCALC_CLI_TRANSPORT: "direct", COCALC_API_RELAY: "1" },
    }),
    undefined,
  );
  assert.throws(
    () => apiTransportMode({ COCALC_CLI_TRANSPORT: "invalid" }),
    /transport/,
  );
  await assert.rejects(
    selectProjectApiRelayTransport({
      apiBaseUrl: "https://prod.test",
      env: { COCALC_CLI_TRANSPORT: "relay" },
    }),
    /not configured/,
  );
});

test("auto probes unknown hubs once, without credentials, and never replays a mutation", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  try {
    Object.assign(process.env, env);
    delete process.env.COCALC_CLI_TRANSPORT;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (init?.method === "HEAD") return new Response(null, { status: 502 });
      return new Response("ambiguous failure", { status: 502 });
    };
    const target = "https://outside.test/api/v2/create";
    const response = await fetchWithProjectApiRelay(
      target,
      {
        method: "POST",
        headers: { Cookie: "caller-cookie" },
        body: "mutation",
      },
      undefined,
      { credentialSite: "https://outside.test" },
    );
    assert.equal(response.status, 502);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init?.method, "HEAD");
    assert.equal(calls[0].init?.body, undefined);
    assert.equal(new Headers(calls[0].init?.headers).get("cookie"), null);
    assert.equal(calls[1].url, target);
    assert.equal(
      new Headers(calls[1].init?.headers).get(API_RELAY_SECRET_HEADER),
      null,
    );
    assert.equal(
      new Headers(calls[1].init?.headers).get("cookie"),
      "caller-cookie",
    );
    assert.equal(
      await selectProjectApiRelayTransport({
        apiBaseUrl: "https://outside.test",
        credentialSite: "https://outside.test",
      }),
      undefined,
    );
    assert.equal(calls.length, 2);
    // Cross-site project-host routing uses the same site choice.
    assert.equal(
      await selectProjectApiRelayTransport({
        apiBaseUrl: "https://outside.test",
        credentialSite: "https://outside.test",
        host: { host_id: projectId, project_id: projectId },
      }),
      undefined,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of Object.keys(process.env))
      if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});

test("same-site and forced relay skip probes; other bays retain relay and coalesce probes", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return new Response(null, { status: 404 });
    };
    assert.ok(
      await selectProjectApiRelayTransport({
        env,
        apiBaseUrl: env.COCALC_API_RELAY_HUB_URL!,
      }),
    );
    assert.ok(
      await selectProjectApiRelayTransport({
        env: { ...env, COCALC_CLI_TRANSPORT: "relay" },
        apiBaseUrl: "https://forced.test",
      }),
    );
    assert.equal(calls, 0);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        selectProjectApiRelayTransport({
          env,
          apiBaseUrl: "https://other-bay.test",
        }),
      ),
    );
    assert.ok(results.every(Boolean));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probe transport failure selects direct, but a failed relay operation is never replayed", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    Object.assign(process.env, env, { COCALC_CLI_TRANSPORT: "auto" });
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(init?.method, "HEAD");
      assert.ok(init.signal instanceof AbortSignal);
      throw Error("unreachable relay");
    };
    assert.equal(
      await selectProjectApiRelayTransport({
        apiBaseUrl: "https://unreachable.test",
        credentialSite: "https://unreachable.test",
      }),
      undefined,
    );
    assert.equal(calls, 1);
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.match(String(url), /\/hub\/api\/v2\/create$/);
      assert.equal(init?.method, "POST");
      throw Error("ambiguous timeout");
    };
    await assert.rejects(
      fetchWithProjectApiRelay("https://site.example/site/api/v2/create", {
        method: "POST",
        body: "mutation",
      }),
      /ambiguous timeout/,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of Object.keys(process.env))
      if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});

test("CLI transport flag overrides the environment before authentication", async () => {
  const home = await mkdtemp(join(tmpdir(), "cli-transport-"));
  const entrypoint = resolve(__dirname, "../bin/cocalc.js");
  const fixture = `
    const assert = require('node:assert/strict');
    globalThis.fetch = async (url, init) => {
      assert.equal(process.env.COCALC_CLI_TRANSPORT, 'direct');
      assert.ok(['https://outside.test/api/v2/accounts/profile',
        'https://outside.test/api/v2/auth/cli/session-status'].includes(String(url)));
      assert.equal(new Headers(init?.headers).get('${API_RELAY_SECRET_HEADER}'), null);
      return new Response(JSON.stringify({profile: {account_id: '${projectId}'}}));
    };
    process.argv.splice(1, 0, ${JSON.stringify(entrypoint)});
    require(${JSON.stringify(entrypoint)});
  `;
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "-e",
        fixture,
        "--",
        "--transport",
        "direct",
        "--api",
        "https://outside.test",
        "--cookie",
        "remember_me=fixture-cookie",
        "--no-daemon",
        "--disable-env-auth-defaults",
        "auth",
        "status",
        "--check",
        "--json",
      ],
      {
        timeout: 15_000,
        cwd: resolve(__dirname, "../.."),
        env: {
          PATH: process.env.PATH,
          HOME: home,
          COCALC_PROFILE: "_env",
          COCALC_CLI_TRANSPORT: "relay",
          COCALC_API_RELAY: "1",
          DEBUG_CONSOLE: "no",
          DEBUG_FILE: "",
        },
      },
    );
    assert.equal(JSON.parse(stdout).data.check.ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("unrelated direct selection never transmits inherited project, API key or hub credentials", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  try {
    Object.assign(process.env, env);
    for (const mode of ["auto", "direct"]) {
      process.env.COCALC_CLI_TRANSPORT = mode;
      for (const extra of [
        {},
        { COCALC_API_KEY: "ambient-key" },
        { COCALC_HUB_PASSWORD: "ambient-password" },
      ]) {
        let probes = 0;
        globalThis.fetch = async (url, init) => {
          probes++;
          assert.match(String(url), /10\.206\.0\.1:9102/);
          assert.equal(init?.method, "HEAD");
          assert.equal(new Headers(init?.headers).get("cookie"), null);
          assert.equal(new Headers(init?.headers).get("authorization"), null);
          return new Response(null, { status: 502 });
        };
        const target = `https://${mode}-${Object.keys(extra)[0] ?? "project"}.invalid`;
        const cookie = buildCookieHeader(target, {}, {}, { ...env, ...extra });
        assert.ok(cookie);
        await assert.rejects(
          fetchWithProjectApiRelay(`${target}/api/v2/auth/bootstrap`, {
            headers: { Cookie: cookie },
          }),
          /destination-scoped/,
        );
        assert.equal(probes, mode === "auto" ? 1 : 0);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of Object.keys(process.env))
      if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
