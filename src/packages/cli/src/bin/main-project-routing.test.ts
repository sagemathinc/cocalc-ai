import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, mock, type TestContext } from "node:test";
import { Command } from "commander";

import { fsSubject } from "@cocalc/conat/files/fs";
import { projectSubject } from "@cocalc/conat/names";
import { resolveApiKeyFileGlobals } from "./core/api-key-file";
import { createProjectJupyterOps } from "./core/project-jupyter";
import type { ProjectCommandDeps } from "./commands/project";
import { registerProjectBasicCommands } from "./commands/project/basic";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const HOST_ID = "33333333-3333-4333-8333-333333333333";
const HOST_URL = "https://project-host.example.com";
const AMBIENT_URL = "http://ambient-project.invalid";
let deps: ProjectCommandDeps;

before(() => {
  // Capture the real CLI composition without parsing argv or exiting the test
  // process. No resolver is replaced; only command registration is intercepted.
  const registration = mock.method(
    require("./commands/project"),
    "registerProjectCommand",
    (_program: Command, actual: ProjectCommandDeps) => {
      deps = actual;
    },
  );
  const parsing = mock.method(
    Command.prototype,
    "parseAsync",
    () => new Promise<Command>(() => {}),
  );
  const log = console.log;
  try {
    require("./main");
  } finally {
    registration.mock.restore();
    parsing.mock.restore();
    console.log = log;
  }
  assert.ok(deps);
});

type Credential = "key-file" | "api-key" | "env-auth-disabled" | "source";

function fixture(t: TestContext, credential: Credential, denied = false) {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-routing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "agent-token");
  const keyFile = join(dir, "api-key");
  writeFileSync(tokenFile, "sealed-agent-token\n", { mode: 0o600 });
  writeFileSync(keyFile, "selected-api-key\n", { mode: 0o600 });
  const env = {
    COCALC_PROJECT_ID: PROJECT_ID,
    COCALC_AGENT_TOKEN_FILE: tokenFile,
    COCALC_BEARER_TOKEN_FILE: "",
    COCALC_BEARER_TOKEN: "",
    COCALC_AGENT_TOKEN: "",
    COCALC_CLI_AGENT_MODE: "1",
    COCALC_SECRET_TOKEN: "ambient-project-secret",
    COCALC_API_KEY: "ambient-api-key",
    CONAT_SERVER: AMBIENT_URL,
    COCALC_API_RELAY: "0",
    COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS: "off",
  };
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const globals =
    credential === "key-file"
      ? resolveApiKeyFileGlobals({ apiKeyFile: keyFile })
      : credential === "api-key"
        ? { apiKey: "selected-api-key" }
        : credential === "env-auth-disabled"
          ? { disableEnvAuthDefaults: true, bearer: "selected-bearer" }
          : {};
  const apiKey = "apiKey" in globals ? globals.apiKey : undefined;
  const project = { project_id: PROJECT_ID, title: "Source", host_id: HOST_ID };
  const token = `header.${Buffer.from(
    JSON.stringify({
      jti: "lease",
      api_key: {
        project_id: PROJECT_ID,
        account_id: ACCOUNT_ID,
        reply_prefix: "_INBOX.api-key-lease",
      },
    }),
  ).toString("base64url")}.signature`;
  const http: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    http.push(url.pathname);
    assert.equal(options.headers?.["Authorization"], "Bearer selected-api-key");
    if (denied) return { ok: false, status: 403 };
    assert.equal(url.pathname, "/api/conat/project-host-api-key");
    assert.equal(JSON.parse(String(options.body)).project_id, PROJECT_ID);
    return {
      ok: true,
      json: async () => ({
        ...project,
        connect_url: HOST_URL,
        local_proxy: false,
        token,
        expires_at: Date.now() + 60_000,
      }),
    };
  });
  const connections: Array<{ address: string; auth?: unknown; client: any }> =
    [];
  const rpc: Array<{ address: string; subject: string; name: string }> = [];
  t.mock.method(require("@cocalc/conat/core/client"), "connect", (options) => {
    const client: any = new EventEmitter();
    const connection = { address: options.address, client, auth: undefined };
    connections.push(connection);
    client.conn = new EventEmitter();
    client.close = () => client.emit("closed");
    client.waitUntilSignedIn = async () => {
      await options.auth((auth) => {
        connection.auth = auth;
      });
    };
    client.request = async (subject: string, { name }) => {
      rpc.push({ address: options.address, subject, name });
      return {
        data:
          name === "system.exec"
            ? { stdout: "", stderr: "", exit_code: 0 }
            : { backend_state: "running", kernel_state: "idle" },
      };
    };
    client.call = (subject: string) =>
      new Proxy(
        {},
        {
          get: (target, name: string) =>
            target[name] ??
            (async () => {
              rpc.push({ address: options.address, subject, name });
              return { files: { "hello.txt": { size: 2 } } };
            }),
        },
      );
    t.after(() => client.close());
    return client;
  });
  let hubCalls = 0;
  const hubOnly = (result: unknown) => async () => {
    hubCalls++;
    assert.equal(
      apiKey,
      undefined,
      "explicit key must not use ambient hub auth",
    );
    return result;
  };
  const ctx = {
    globals,
    apiKey,
    accountId: ACCOUNT_ID,
    apiBaseUrl: "https://hub.example.com",
    timeoutMs: 1_000,
    rpcTimeoutMs: 1_000,
    projectCache: new Map(),
    hostConnectionCache: new Map(),
    routedProjectHostClients: {},
    remote: { client: {}, user: { account_id: ACCOUNT_ID } },
    hub: {
      db: { userQuery: hubOnly({ projects: [project] }) },
      system: { getProjectBay: hubOnly(project) },
      hosts: {
        resolveHostConnection: hubOnly({
          host_id: HOST_ID,
          connect_url: HOST_URL,
          local_proxy: false,
        }),
        issueProjectHostAuthToken: hubOnly({
          token: "selected-account-host-token",
          expires_at: Date.now() + 60_000,
        }),
      },
    },
  };
  return { ctx, http, connections, rpc, hubCalls: () => hubCalls, token };
}

async function exec(ctx: unknown) {
  const program = new Command();
  registerProjectBasicCommands(program.command("project"), {
    ...deps,
    withContext: async (_command, _label, fn) => await fn(ctx),
  });
  await program.parseAsync(
    ["project", "exec", "--project", PROJECT_ID, "true"],
    { from: "user" },
  );
}

for (const credential of [
  "key-file",
  "api-key",
  "env-auth-disabled",
] as const) {
  test(`uncached filesystem routing honors ${credential} in the source project`, async (t) => {
    const f = fixture(t, credential);
    const files = await deps.projectFileListData({
      ctx: f.ctx,
      projectIdentifier: PROJECT_ID,
    });
    assert.equal(files[0].project_id, PROJECT_ID);
    assert.equal(f.connections[0].address, HOST_URL);
    assert.equal(f.rpc[0].subject, fsSubject({ project_id: PROJECT_ID }));
    if (credential !== "env-auth-disabled") assert.equal(f.hubCalls(), 0);
  });

  test(`real exec, Jupyter/SyncDB and file resolvers honor ${credential} over ambient agent auth`, async (t) => {
    const f = fixture(t, credential);
    await exec(f.ctx);
    await deps.projectJupyterStatusData({
      ctx: f.ctx,
      projectIdentifier: PROJECT_ID,
      path: "/notebook.ipynb",
    });
    // A separate ops instance gives this test ownership of its SyncDB lease.
    const jupyter = createProjectJupyterOps({
      resolveProjectConatClient: deps.resolveProjectConatClient,
    });
    t.after(() => jupyter.close());
    let syncdbClient: unknown;
    t.mock.method(
      require("@cocalc/conat/sync-doc/syncdb"),
      "syncdb",
      (opts) => {
        syncdbClient = opts.client;
        assert.equal(opts.project_id, PROJECT_ID);
        return {
          get_state: () => "ready",
          get: () => [],
          close: async () => {},
        };
      },
    );
    await jupyter.projectJupyterCellsData({
      ctx: f.ctx,
      projectIdentifier: PROJECT_ID,
      path: "/notebook.ipynb",
    });
    // No cached project: exercise the file resolver's source-project lookup too.
    f.ctx.projectCache.clear();
    const files = await deps.projectFileListData({
      ctx: f.ctx,
      projectIdentifier: PROJECT_ID,
    });
    assert.equal(files[0].name, "hello.txt");
    assert.equal(f.connections.length, 1);
    assert.equal(f.connections[0].address, HOST_URL);
    assert.equal(syncdbClient, f.connections[0].client);
    assert.deepEqual(f.connections[0].auth, {
      bearer:
        credential === "env-auth-disabled"
          ? "selected-account-host-token"
          : f.token,
    });
    assert.deepEqual(
      f.rpc.map(({ name }) => name),
      ["system.exec", "jupyter.getKernelStatus", "jupyter.start", "getListing"],
    );
    assert.ok(f.rpc.every(({ address }) => address === HOST_URL));
    assert.equal(
      f.rpc[0].subject,
      projectSubject({ project_id: PROJECT_ID, service: "api" }),
    );
    assert.equal(f.rpc[3].subject, fsSubject({ project_id: PROJECT_ID }));
    if (credential !== "env-auth-disabled") {
      assert.ok(f.http.length >= 3);
      assert.equal(f.hubCalls(), 0);
    } else {
      assert.equal(f.http.length, 0);
      assert.ok(f.hubCalls() > 0);
    }
  });
}

for (const name of [
  "exec",
  "projectJupyterStatusData",
  "projectJupyterCellsData",
  "projectFileListData",
] as const) {
  test(`denied explicit key never retries ${name} with ambient auth`, async (t) => {
    const f = fixture(t, "key-file", true);
    await assert.rejects(
      () =>
        name === "exec"
          ? exec(f.ctx)
          : deps[name]({
              ctx: f.ctx,
              projectIdentifier: PROJECT_ID,
              path: "/notebook.ipynb",
            }),
      /API request failed \(403\)/,
    );
    assert.equal(f.http.length, 2);
    assert.equal(f.hubCalls(), 0);
    assert.deepEqual(f.connections, []);
    assert.deepEqual(f.rpc, []);
  });
}

test("default source-project exec and files preserve sealed agent access without account discovery", async (t) => {
  const f = fixture(t, "source");
  await exec(f.ctx);
  assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0].address, AMBIENT_URL);
  assert.deepEqual(f.connections[0].auth, {
    bearer: "sealed-agent-token",
    project_id: PROJECT_ID,
  });
  // Project-only context admission reuses this connection for free-user files.
  Object.assign(f.ctx, {
    currentProjectId: PROJECT_ID,
    currentProjectClient: f.connections[0].client,
  });
  const files = await deps.projectFileListData({ ctx: f.ctx });
  assert.equal(files[0].project_id, PROJECT_ID);
  assert.equal(f.rpc[1].address, AMBIENT_URL);
  assert.equal(f.rpc[1].subject, fsSubject({ project_id: PROJECT_ID }));
  assert.equal(f.http.length, 0);
  assert.equal(f.hubCalls(), 0);
  assert.equal(f.rpc[0].name, "system.exec");
});
