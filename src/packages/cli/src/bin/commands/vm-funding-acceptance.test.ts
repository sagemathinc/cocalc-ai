import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import { registerVmCommand } from "./vm";
import { registerComputeFundingCommand } from "./compute-funding";
import { emitError, emitSuccess } from "../core/cli-output";

const id = "10000000-0000-4000-8000-000000000001";
const consent = "10000000-0000-4000-8000-000000000002";
const operation = "10000000-0000-4000-8000-000000000003";
const source = {
  kind: "course",
  payer_account_id: id,
  pool_id: consent,
  grant_id: operation,
};
const terms = {
  vm_id: id,
  expected_funding_version: "epoch:7",
  home_volume_ids: [],
  lane: "prepaid",
  cap_usd: "12.34",
  ends_at: "2099-01-01T00:00:00.000Z",
  activation: "immediate",
  fallback_reasons: [],
};
const status = {
  source,
  label: "Physics lab",
  funding_version: "epoch:7",
  lane: "prepaid",
  state: "running",
  committed_usd: "2.00",
  authorized_until: "2026-09-13T10:00:00Z",
  storage_delete_at: "2026-09-16T10:00:00Z",
  as_of: "2026-09-13T09:00:00Z",
};

function harness({
  user = {},
  response = undefined,
  error = undefined,
}: { user?: object; response?: any; error?: Error } = {}) {
  const calls: Array<{ api: string; method: string; args: any }> = [];
  const outputs: any[] = [];
  const globals: any[] = [];
  const program = new Command()
    .exitOverride()
    .option("--json")
    .option("--api <url>");
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const api = (api: string) =>
    new Proxy(
      {},
      {
        get: (_, method) => async (args: any) => {
          calls.push({ api, method: String(method), args });
          if (error) throw error;
          return response;
        },
      },
    );
  const withContext = async (command: Command, label: string, fn: any) => {
    const options = command.optsWithGlobals();
    globals.push(options);
    const ctx = {
      globals: options,
      remote: { user },
      apiBaseUrl: options.api,
      hub: { compute: api("compute"), computeFunding: api("computeFunding") },
    };
    const capture = (f: () => void) => {
      const originalLog = console.log,
        originalError = console.error;
      console.log = console.error = (line: string) =>
        outputs.push(JSON.parse(line));
      try {
        f();
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }
    };
    try {
      const result = await fn(ctx);
      capture(() => emitSuccess(ctx, label, result));
    } catch (err) {
      capture(() => emitError(ctx, label, err, (value) => value));
      throw err;
    }
  };
  registerVmCommand(program, { withContext, progress: () => {} });
  registerComputeFundingCommand(program, { withContext });
  return {
    calls,
    outputs,
    globals,
    run: (...args: string[]) =>
      program.parseAsync(
        ["--api", "https://isolated.example.invalid", ...args, "--json"],
        { from: "user" },
      ),
  };
}

test("all five personal funding commands execute through registerVmCommand with inherited JSON/API globals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "funding-cli-acceptance-"));
  try {
    const file = join(directory, "terms.json");
    writeFileSync(file, JSON.stringify(terms));
    for (const [action, method, args, response] of [
      [
        "preview",
        "previewVmPersonalFunding",
        ["--terms", file],
        {
          terms,
          hourly_usd: "0.10",
          storage_hourly_usd: "0.01",
          as_of: status.as_of,
        },
      ],
      [
        "propose",
        "proposeVmPersonalFunding",
        ["--terms", file, "--operation", operation],
        {
          id: consent,
          version: 1,
          state: "pending",
          approval_url: "https://approval.example.invalid/review/opaque",
        },
      ],
      [
        "status",
        "getVmPersonalFunding",
        [id],
        { id: consent, version: 2, state: "approved", terms },
      ],
      [
        "cancel",
        "clearVmPersonalFunding",
        [
          id,
          "--consent",
          consent,
          "--expected-version",
          "2",
          "--operation",
          operation,
        ],
        { id: consent, version: 3, state: "cancelled" },
      ],
      [
        "apply",
        "switchVmPersonalFunding",
        [
          id,
          "--consent",
          consent,
          "--expected-version",
          "2",
          "--operation",
          operation,
          "--expected-funding-version",
          "epoch:7",
        ],
        { id: consent, version: 3, state: "preparing" },
      ],
    ] as const) {
      const h = harness({ response });
      await h.run("vm", "personal-funding", action, ...args);
      assert.deepEqual(
        h.calls.map((call) => `${call.api}.${call.method}`),
        [`compute.${method}`],
      );
      assert.equal(h.globals[0].json, true);
      assert.equal(h.globals[0].api, "https://isolated.example.invalid");
      assert.deepEqual(h.outputs[0].data, response);
      if (action === "apply") {
        assert.equal(h.calls[0].args.expected_version, 2);
        assert.equal(h.calls[0].args.expected_funding_version, "epoch:7");
        assert.equal(h.outputs[0].data.state, "preparing");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("funding readout preserves authorized source, status and deadlines through account/project/agent methods", async () => {
  for (const user of [
    {},
    { project_id: id },
    { auth_actor: "agent", auth_project_id: id },
  ]) {
    const h = harness({
      user,
      response: {
        id,
        name: "lab-vm",
        owner_account_id: id,
        funding_mode: "account-prepaid",
        funding_status: status,
        stop_at: "2026-09-13T10:00:00Z",
        expires_at: "2026-09-16T10:00:00Z",
        updated_at: "2026-09-12T10:00:00Z",
        metadata: { private: "must not forward raw metadata" },
      },
    });
    await h.run("vm", "funding", id);
    assert.equal(
      h.calls[0].method,
      Object.keys(user).length ? "getProjectVm" : "getVm",
    );
    assert.equal(h.calls.length, 1);
    const data = h.outputs[0].data;
    assert.deepEqual(data.funding_status, status);
    assert.equal(data.stop_at, "2026-09-13T10:00:00Z");
    assert.equal(data.expires_at, "2026-09-16T10:00:00Z");
    assert.equal(data.updated_at, "2026-09-12T10:00:00Z");
    assert.equal(data.metadata, undefined);
  }
});
test("missing funding is null rather than fabricated personal funding or zero", async () => {
  const h = harness({ response: { id, name: "legacy" } });
  await h.run("vm", "funding", id);
  assert.equal(h.outputs[0].data.funding_status, null);
  assert.equal(h.outputs[0].data.funding_mode, undefined);
});
test("course sources registration and alias preserve authoritative labels, timestamps and history selection", async () => {
  const response = {
    as_of: status.as_of,
    sources: [
      {
        ...source,
        label: "Physics lab",
        available_usd: "4.00",
        state: "active",
      },
    ],
  };
  for (const alias of ["computeFunding", "compute-funding"]) {
    const h = harness({ response });
    await h.run(alias, "sources", "--include-inactive");
    assert.deepEqual(h.calls, [
      {
        api: "computeFunding",
        method: "listSources",
        args: { include_inactive: true },
      },
    ]);
    assert.deepEqual(h.outputs[0].data, response);
  }
});
test("host aliases and project agents cannot use account-only source or consent reads", async () => {
  for (const user of [
    { auth_host_id: id },
    { host_id: id },
    { project_id: id },
    { auth_project_id: id },
    { auth_actor: "agent" },
  ]) {
    for (const args of [
      ["compute-funding", "sources"],
      ["vm", "personal-funding", "status", id],
    ]) {
      const h = harness({ user });
      await assert.rejects(h.run(...args), /account authentication/);
      assert.equal(h.calls.length, 0);
      assert.equal(h.outputs[0].error.code, "account_auth_required");
    }
  }
});
test("registered apply preserves structured denial and adds recovery advice without fallback RPC", async () => {
  const error = Object.assign(Error("Personal funding consent changed."), {
    code: "funding_unavailable",
  });
  const h = harness({ error });
  await assert.rejects(
    h.run(
      "vm",
      "personal-funding",
      "apply",
      id,
      "--consent",
      consent,
      "--expected-version",
      "2",
      "--operation",
      operation,
      "--expected-funding-version",
      "epoch:7",
    ),
    (err) => err === error,
  );
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "switchVmPersonalFunding");
  assert.equal(h.outputs[0].error.code, error.code);
  assert.equal(h.outputs[0].error.message, error.message);
  assert.match(
    h.outputs[0].error.hint,
    /Never automatically.*replace versions/,
  );
});
test("account source denial never retries with personal funding or another API", async () => {
  const h = harness({
    error: Object.assign(Error("Allowance unavailable"), {
      code: "funding_unavailable",
    }),
  });
  await assert.rejects(h.run("compute-funding", "sources"));
  assert.equal(h.calls.length, 1);
  assert.match(
    h.outputs[0].error.hint,
    /--funding-payer, --funding-pool and --funding-grant/,
  );
});
