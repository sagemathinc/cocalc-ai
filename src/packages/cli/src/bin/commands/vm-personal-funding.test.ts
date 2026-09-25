import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { Command } from "commander";
import { registerVmCommand } from "./vm";
import {
  parseVmPersonalFundingTerms,
  registerVmPersonalFundingCommand,
} from "./vm-personal-funding";

const vm = "10000000-0000-4000-8000-000000000001";
const consent = "10000000-0000-4000-8000-000000000002";
const operation = "10000000-0000-4000-8000-000000000003";
const terms = {
  vm_id: vm,
  expected_funding_version: "epoch:7",
  home_volume_ids: [],
  lane: "prepaid",
  cap_usd: "12.34",
  ends_at: "2099-01-01T00:00:00.000Z",
  activation: "immediate",
  fallback_reasons: [],
};
const normalized = { ...terms, cap_usd: "12.3400000000" };
const result = {
  id: consent,
  version: 1,
  state: "pending",
  approval_url: "https://approval.example.test/review/opaque-intent",
};

function harness(
  opts: {
    user?: object;
    attempts?: number;
    readTerms?: (path: string) => string;
    realFile?: boolean;
    realVm?: boolean;
    error?: Error;
    response?: unknown;
  } = {},
) {
  const calls: { name: string; args: unknown }[] = [];
  const results: unknown[] = [];
  let reads = 0;
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const withContext = async (_command, _name, fn) => {
    for (let i = 0; i < (opts.attempts ?? 1); i++) {
      results.push(
        await fn({
          remote: { user: opts.user ?? {} },
          hub: {
            compute: new Proxy(
              {},
              {
                get: (_, name) => async (args) => {
                  calls.push({ name: String(name), args });
                  if (opts.error) throw opts.error;
                  return "response" in opts ? opts.response : result;
                },
              },
            ),
          },
        }),
      );
    }
  };
  if (opts.realVm) registerVmCommand(program, { withContext });
  else
    registerVmPersonalFundingCommand(program.command("vm"), {
      withContext,
      readTerms: opts.realFile
        ? undefined
        : (path) => {
            reads++;
            return opts.readTerms?.(path) ?? JSON.stringify(terms);
          },
    });
  return {
    calls,
    results,
    reads: () => reads,
    run: (...args: string[]) =>
      program.parseAsync(["vm", "personal-funding", ...args], { from: "user" }),
  };
}

it("registers actual personal funding callers under the existing vm command", async () => {
  const h = harness({ realVm: true });
  await h.run("status", vm);
  assert.deepEqual(h.calls, [
    { name: "getVmPersonalFunding", args: { vm_id: vm } },
  ]);
});

it("previews bounded exact terms without creating or approving an intent", async () => {
  const h = harness();
  await h.run("preview", "--terms", "-");
  assert.deepEqual(h.calls, [
    { name: "previewVmPersonalFunding", args: { terms: normalized } },
  ]);
});

it("proposes stable terms across context retries and preserves the isolated approval URL", async () => {
  const h = harness({ attempts: 2 });
  await h.run("propose", "--terms", "terms.json", "--operation", operation);
  assert.equal(h.reads(), 1);
  assert.deepEqual(
    h.calls,
    Array(2).fill({
      name: "proposeVmPersonalFunding",
      args: { terms: normalized, operation_id: operation },
    }),
  );
  assert.deepEqual(h.results, [result, result]);
});

it("passes explicit fallback reasons and home-volume identities without adding defaults", async () => {
  const input = {
    ...terms,
    activation: "fallback",
    lane: "postpaid",
    home_volume_ids: [operation, consent],
    fallback_reasons: ["course_expired", "course_exhausted"],
  };
  const h = harness({ readTerms: () => JSON.stringify(input) });
  await h.run("preview", "--terms", "-");
  assert.deepEqual(h.calls[0].args, {
    terms: {
      ...input,
      cap_usd: normalized.cap_usd,
      home_volume_ids: [consent, operation],
      fallback_reasons: ["course_exhausted", "course_expired"],
    },
  });
});

it("status preserves absent consent as null rather than inventing approval or budget", async () => {
  const h = harness({ response: null });
  await h.run("status", vm);
  assert.deepEqual(h.results, [null]);
});

it("cancel and apply use only their exact versioned hub.compute methods", async () => {
  for (const action of ["cancel", "apply"]) {
    const h = harness({ attempts: 2 });
    await h.run(
      action,
      vm,
      "--consent",
      consent,
      "--expected-version",
      "4",
      "--operation",
      operation,
      ...(action === "apply" ? ["--expected-funding-version", "epoch:7"] : []),
    );
    const args = {
      vm_id: vm,
      consent_id: consent,
      expected_version: 4,
      operation_id: operation,
      ...(action === "apply" ? { expected_funding_version: "epoch:7" } : {}),
    };
    assert.deepEqual(
      h.calls,
      Array(2).fill({
        name:
          action === "cancel"
            ? "clearVmPersonalFunding"
            : "switchVmPersonalFunding",
        args,
      }),
    );
  }
});

it("surfaces unapproved or unavailable handoffs without a legacy funding/create/start fallback", async () => {
  const error = Error("Personal funding handoff is not yet available.");
  const h = harness({ error });
  await assert.rejects(
    h.run(
      "apply",
      vm,
      "--consent",
      consent,
      "--expected-version",
      "4",
      "--operation",
      operation,
      "--expected-funding-version",
      "epoch:7",
    ),
    error,
  );
  assert.deepEqual(
    h.calls.map((call) => call.name),
    ["switchVmPersonalFunding"],
  );
});

it("rejects project, host and agent credentials before any personal funding RPC", async () => {
  for (const user of [
    { project_id: vm },
    { auth_project_id: vm },
    { host_id: vm },
    { auth_host_id: vm },
    { auth_actor: "agent" },
  ]) {
    for (const args of [
      ["preview", "--terms", "-"],
      ["propose", "--terms", "-", "--operation", operation],
      ["status", vm],
      [
        "cancel",
        vm,
        "--consent",
        consent,
        "--expected-version",
        "1",
        "--operation",
        operation,
      ],
      [
        "apply",
        vm,
        "--consent",
        consent,
        "--expected-version",
        "1",
        "--operation",
        operation,
        "--expected-funding-version",
        "epoch:7",
      ],
    ]) {
      const h = harness({ user });
      await assert.rejects(h.run(...args), /account authentication/);
      assert.equal(h.calls.length, 0);
    }
  }
});

it("requires explicit terms, operation and consent/funding versions with no approve command", async () => {
  for (const args of [
    ["preview"],
    ["propose", "--terms", "-"],
    ["cancel", vm, "--consent", consent, "--operation", operation],
    ["cancel", vm, "--expected-version", "1", "--operation", operation],
    [
      "apply",
      vm,
      "--consent",
      consent,
      "--expected-version",
      "1",
      "--operation",
      operation,
    ],
    ["approve", consent],
    ["propose", "--terms", "-", "--operation", operation, "--approve"],
    [
      "apply",
      vm,
      "--consent",
      consent,
      "--expected-version",
      "1",
      "--operation",
      operation,
      "--expected-funding-version",
      "epoch:7",
      "--yes",
    ],
  ]) {
    const h = harness();
    await assert.rejects(h.run(...args));
    assert.equal(h.calls.length, 0);
  }
});

it("rejects malformed identities and stale-version syntax before calling the API", async () => {
  for (const value of ["-1", "1.5", "1e3", "9007199254740992", "", "01"]) {
    const h = harness();
    await assert.rejects(
      h.run(
        "cancel",
        vm,
        "--consent",
        consent,
        "--expected-version",
        value,
        "--operation",
        operation,
      ),
    );
    assert.equal(h.calls.length, 0);
  }
  for (const args of [
    ["status", "name-instead-of-uuid"],
    ["propose", "--terms", "-", "--operation", "invalid"],
    [
      "cancel",
      vm,
      "--consent",
      "invalid",
      "--expected-version",
      "1",
      "--operation",
      operation,
    ],
    [
      "apply",
      vm,
      "--consent",
      consent,
      "--expected-version",
      "1",
      "--operation",
      operation,
      "--expected-funding-version",
      " ",
    ],
  ]) {
    const h = harness();
    await assert.rejects(h.run(...args));
    assert.equal(h.calls.length, 0);
  }
});

it("rejects unbounded, ambiguous or extra financial terms before any RPC", async () => {
  for (const patch of [
    { cap_usd: "0" },
    { cap_usd: "-1" },
    { cap_usd: "NaN" },
    { cap_usd: 12.34 },
    { cap_usd: "1.001" },
    { cap_usd: "10000000000" },
    { ends_at: undefined },
    { ends_at: "tomorrow" },
    { ends_at: "2099-01-01T00:00:00" },
    { lane: undefined },
    { activation: undefined },
    { activation: "fallback", fallback_reasons: [] },
    { fallback_reasons: ["course_expired"] },
    { activation: "fallback", fallback_reasons: ["any_failure"] },
    { home_volume_ids: undefined },
    { home_volume_ids: Array(101).fill(vm) },
    { home_volume_ids: ["invalid"] },
    { expected_funding_version: "" },
    { expected_funding_version: "x".repeat(513) },
    { payer_account_id: consent },
    { approved: true },
    { approval_token: "token" },
    { stop_after_minutes: null },
    { lane: "free" },
  ]) {
    const h = harness({
      readTerms: () => JSON.stringify({ ...terms, ...patch }),
    });
    await assert.rejects(
      h.run("propose", "--terms", "-", "--operation", operation),
    );
    assert.equal(h.calls.length, 0);
  }
  for (const text of ["{", "null", "[]", "x".repeat(65537)])
    assert.throws(() => parseVmPersonalFundingTerms(text));
});

it("reads a real terms file through the registered vm caller and rejects oversized input", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vm-personal-funding-"));
  try {
    const file = join(directory, "terms.json");
    writeFileSync(file, JSON.stringify(terms));
    const h = harness({ realVm: true });
    await h.run("preview", "--terms", file);
    assert.deepEqual(h.calls, [
      { name: "previewVmPersonalFunding", args: { terms: normalized } },
    ]);
    writeFileSync(file, " ".repeat(65537));
    const oversized = harness({ realFile: true });
    await assert.rejects(oversized.run("preview", "--terms", file), /64 KiB/);
    assert.equal(oversized.calls.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("bounds real stdin input and forwards valid stdin terms without external RPC", () => {
  const script = `
    const { Command } = require('commander');
    const { registerVmPersonalFundingCommand } = require(${JSON.stringify(require.resolve("./vm-personal-funding"))});
    const program = new Command().exitOverride();
    registerVmPersonalFundingCommand(program.command('vm'), {
      withContext: async (_command, _name, callback) => {
        const result = await callback({hub:{compute:{previewVmPersonalFunding: async args => args}}});
        process.stdout.write(JSON.stringify(result));
      }
    });
    program.parseAsync(['vm','personal-funding','preview','--terms','-'], {from:'user'})
      .catch(error => process.stdout.write(JSON.stringify({error:error.message})));
  `;
  const valid = spawnSync(process.execPath, ["-e", script], {
    input: JSON.stringify(terms),
    encoding: "utf8",
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), { terms: normalized });
  const oversized = spawnSync(process.execPath, ["-e", script], {
    input: " ".repeat(65537),
    encoding: "utf8",
  });
  assert.equal(oversized.status, 0, oversized.stderr);
  assert.match(JSON.parse(oversized.stdout).error, /64 KiB/);
});
