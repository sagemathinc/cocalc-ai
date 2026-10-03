import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import type { ResolvedPersonalUrl } from "@cocalc/util/personal-urls";
import {
  createHubApiForContext,
  hubCallByName,
  type HubCallContext,
} from "../core/context";
import { emitSuccess } from "../core/cli-output";
import { registerAccountCommand } from "./account";
import { registerAdminCommand } from "./admin";
import {
  registerUrlCommand,
  type PersonalUrlsCommandDeps,
} from "./personal-urls";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const API_URL = "https://configured.example.invalid";
const INPUT_URL = "https://untrusted.example.invalid/u/alice/artifacts/report";
const RESOLVED: ResolvedPersonalUrl = {
  owner: { account_id: OWNER_ID, username: "alice", redirect: false },
  kind: "artifacts",
  alias: "report",
  canonical_path: "/u/alice/artifacts/report",
  status: "resolved",
  target: {
    kind: "artifact",
    project_id: PROJECT_ID,
    entry_id: "entry-id",
    artifact_id: "artifact-id",
    chat_path: "chat.chat",
    thread_id: "thread-id",
  },
};

function harness({
  result = {},
  error,
  user = { auth_session_hash: "session-hash" },
}: {
  result?: unknown;
  error?: Error;
  user?: HubCallContext["remote"]["user"];
} = {}) {
  const calls: Parameters<Parameters<typeof hubCallByName>[0]["callHub"]>[0][] =
    [];
  const outputs: {
    label: string;
    data: unknown;
    globals: Record<string, unknown>;
  }[] = [];
  const ctx: HubCallContext = {
    accountId: ACCOUNT_ID,
    timeoutMs: 30_000,
    rpcTimeoutMs: 15_000,
    remote: { client: {} as HubCallContext["remote"]["client"], user },
  };
  const hub = createHubApiForContext(async <T>(name, args, timeout) =>
    hubCallByName<T>({
      ctx,
      name,
      args,
      timeout,
      callHub: async (request) => {
        calls.push(request);
        if (!request.name.startsWith("personalUrls.")) {
          throw new Error(`unexpected non-personal-URL API: ${request.name}`);
        }
        if (error) throw error;
        return result;
      },
    }),
  );
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .option("--json")
    .option("--profile <name>")
    .option("--api <url>")
    .option("--account-id <uuid>")
    .option("--bearer <token>")
    .option("--disable-env-auth-defaults");
  const deps: PersonalUrlsCommandDeps = {
    withContext: async (command, label, fn) => {
      const data = await fn({ hub });
      outputs.push({ label, data, globals: command.optsWithGlobals() });
    },
  };
  registerUrlCommand(program, deps);
  registerAccountCommand(program, {
    ...deps,
    toIso: (x) => x,
    resolveAccountByIdentifier: () => {
      throw new Error("unexpected account search");
    },
  });
  registerAdminCommand(program, {
    ...deps,
    resolveAccountByIdentifier: () => {
      throw new Error("unexpected account search");
    },
    isValidUUID: () => true,
    waitForLro: () => {
      throw new Error("unexpected project startup or long-running operation");
    },
  });
  return {
    calls,
    outputs,
    run: (args: string[]) => program.parseAsync(args, { from: "user" }),
  };
}

test("URL resolution uses only the configured authenticated hub and preserves JSON fields", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("URL resolution must not fetch the input URL");
  });
  const result = RESOLVED;
  const h = harness({ result });
  await h.run([
    "--profile",
    "support",
    "--api",
    API_URL,
    "--account-id",
    ACCOUNT_ID,
    "--bearer",
    "synthetic-token",
    "--disable-env-auth-defaults",
    "url",
    "resolve",
    INPUT_URL,
    "--json",
  ]);
  assert.deepEqual(h.calls, [
    {
      client: {},
      account_id: ACCOUNT_ID,
      auth_session_hash: "session-hash",
      name: "personalUrls.resolveUrl",
      args: [{ url: INPUT_URL }],
      timeout: 15_000,
    },
  ]);
  assert.deepEqual(h.outputs[0].globals, {
    profile: "support",
    api: API_URL,
    accountId: ACCOUNT_ID,
    bearer: "synthetic-token",
    disableEnvAuthDefaults: true,
    json: true,
  });
  assert.strictEqual(h.outputs[0].data, result);
  const log = t.mock.method(console, "log", () => {});
  emitSuccess(
    { globals: { json: true }, apiBaseUrl: API_URL, accountId: ACCOUNT_ID },
    h.outputs[0].label,
    h.outputs[0].data,
  );
  const json = JSON.parse(log.mock.calls[0].arguments[0]);
  assert.deepEqual(json, {
    ok: true,
    command: "url resolve",
    data: result,
    meta: { api: API_URL, account_id: ACCOUNT_ID },
  });
});

test("URL inspection is explicit and preserves minimal locators without reading content", async () => {
  const result: ResolvedPersonalUrl = {
    ...RESOLVED,
    status: "inspection",
    target: { kind: "artifact", project_id: PROJECT_ID, entry_id: "entry-id" },
  };
  const h = harness({ result });
  await h.run(["url", "resolve", INPUT_URL, "--inspect", "--json"]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].args, [{ url: INPUT_URL, inspect: true }]);
  assert.strictEqual(h.outputs[0].data, result);
});

test("unavailable and access-denied results remain metadata, with no automatic inspection", async () => {
  for (const status of ["unavailable", "access-denied"] as const) {
    const { target: _target, ...base } = RESOLVED;
    const result: ResolvedPersonalUrl = {
      ...base,
      status,
      project_id: PROJECT_ID,
    };
    const h = harness({ result });
    await h.run(["url", "resolve", "/u/alice/artifacts/report", "--json"]);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].args, [{ url: "/u/alice/artifacts/report" }]);
    assert.strictEqual(h.outputs[0].data, result);
    assert.equal("target" in (h.outputs[0].data as ResolvedPersonalUrl), false);
  }
});

test("people aliases use the same authorized resolver, not public account searches", async () => {
  const h = harness();
  await h.run(["url", "resolve", "/u/alice/people/colleague"]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].name, "personalUrls.resolveUrl");
  assert.deepEqual(h.calls[0].args, [{ url: "/u/alice/people/colleague" }]);
});

test("username get/set/clear act on the authenticated account without target overrides", async () => {
  const result = {
    account_id: ACCOUNT_ID,
    username: "alice",
    redirects: ["old-alice"],
  };
  for (const [args, method, payload] of [
    [["get"], "getUsername", {}],
    [["set", "alice"], "setUsername", { username: "alice" }],
    [["clear"], "setUsername", { username: null }],
  ] as const) {
    const h = harness({ result });
    await h.run(["account", "username", ...args, "--json"]);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].name, `personalUrls.${method}`);
    assert.deepEqual(h.calls[0].args, [payload]);
    assert.strictEqual(h.outputs[0].data, result);
  }
});

test("admin inspection targets owner UUID without changing the authenticated principal", async () => {
  const result = { account_id: OWNER_ID, username: null, redirects: ["alice"] };
  const h = harness({ result });
  await h.run(["admin", "username", "inspect", OWNER_ID, "--json"]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].account_id, ACCOUNT_ID);
  assert.equal(h.calls[0].name, "personalUrls.getUsername");
  assert.deepEqual(h.calls[0].args, [{ owner_account_id: OWNER_ID }]);
  assert.strictEqual(h.outputs[0].data, result);
});

test("redirect release requires explicit confirmation and forwards the exact audit target", async () => {
  const h = harness();
  await h.run([
    "admin",
    "username",
    "release-redirect",
    OWNER_ID,
    "old-alice",
    "--reason",
    "support ticket 123",
    "--yes",
    "--json",
  ]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].account_id, ACCOUNT_ID);
  assert.equal(h.calls[0].auth_session_hash, "session-hash");
  assert.equal(h.calls[0].name, "personalUrls.releaseRedirect");
  assert.deepEqual(h.calls[0].args, [
    {
      owner_account_id: OWNER_ID,
      username: "old-alice",
      reason: "support ticket 123",
    },
  ]);
  assert.deepEqual(h.outputs[0].data, {
    owner_account_id: OWNER_ID,
    username: "old-alice",
    released: true,
  });
});

test("invalid or unconfirmed requests never reach the hub", async () => {
  for (const [args, message] of [
    [["url", "resolve", "  "], /URL must not be empty/],
    [["account", "username", "set", "  "], /username must not be empty/],
    [["admin", "username", "inspect", "alice"], /must be a UUID/],
    [
      [
        "admin",
        "username",
        "release-redirect",
        OWNER_ID,
        "alice",
        "--reason",
        "support",
      ],
      /pass --yes/,
    ],
    [
      ["admin", "username", "release-redirect", OWNER_ID, "alice", "--yes"],
      /required option.*reason/,
    ],
    [
      [
        "admin",
        "username",
        "release-redirect",
        OWNER_ID,
        "alice",
        "--yes",
        "--reason",
        "  ",
      ],
      /reason must not be empty/,
    ],
    [
      [
        "admin",
        "username",
        "release-redirect",
        "alice",
        "old-alice",
        "--yes",
        "--reason",
        "support",
      ],
      /must be a UUID/,
    ],
  ] as const) {
    const h = harness();
    await assert.rejects(h.run([...args]), message);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.outputs, []);
  }
});

test("authorization, availability, and fresh-auth failures propagate without alternate lookups", async () => {
  for (const [args, code] of [
    [["url", "resolve", INPUT_URL], "permission_denied"],
    [["url", "resolve", INPUT_URL, "--inspect"], "permission_denied"],
    [["url", "resolve", INPUT_URL], "not_found"],
    [["account", "username", "set", "alice"], "username_unavailable"],
    [["admin", "username", "inspect", OWNER_ID], "permission_denied"],
    [
      [
        "admin",
        "username",
        "release-redirect",
        OWNER_ID,
        "alice",
        "--yes",
        "--reason",
        "support",
      ],
      "fresh_auth_required",
    ],
  ] as const) {
    const error = Object.assign(new Error(code), { code });
    const h = harness({ error });
    await assert.rejects(h.run([...args]), (err) => err === error);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.outputs, []);
  }
});

test("malformed URLs and embedded credentials fail shared parsing before the hub call", async () => {
  for (const value of [
    "https://user:secret@example.invalid/u/alice/artifacts/report",
    "//example.invalid/u/alice/artifacts/report",
    "file:///u/alice/artifacts/report",
    "/u/alice/unknown/report",
    "/u/alice/artifacts/a%2Fb",
    "/u/alice/artifacts/%",
  ]) {
    const h = harness();
    await assert.rejects(h.run(["url", "resolve", value]));
    assert.deepEqual(h.calls, []);
  }
});

test("URL resolution preserves project and agent principals rather than escalating to the owner", async () => {
  const project = harness({ user: { project_id: PROJECT_ID } });
  await project.run(["url", "resolve", INPUT_URL]);
  assert.equal(project.calls[0].project_id, PROJECT_ID);
  assert.equal(project.calls[0].account_id, undefined);
  const agent = harness({
    user: {
      auth_actor: "agent",
      auth_project_id: PROJECT_ID,
      auth_token_fingerprint: "a".repeat(64),
      auth_iat_s: 100,
      auth_exp_s: 1000,
    },
  });
  await agent.run(["url", "resolve", INPUT_URL]);
  assert.equal(agent.calls[0].account_id, undefined);
  assert.equal(agent.calls[0].project_id, undefined);
  assert.deepEqual(agent.calls[0].agent, {
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    token_fingerprint: "a".repeat(64),
    issued_at_s: 100,
    expires_at_s: 1000,
  });
});
