import assert from "node:assert/strict";
import { it } from "node:test";
import { Command } from "commander";
import { registerVmCommand } from "./vm";

const source = {
  kind: "course" as const,
  payer_account_id: "10000000-0000-4000-8000-000000000001",
  pool_id: "10000000-0000-4000-8000-000000000002",
  grant_id: "10000000-0000-4000-8000-000000000003",
};
const flags = [
  "--funding-payer",
  source.payer_account_id,
  "--funding-pool",
  source.pool_id,
  "--funding-grant",
  source.grant_id,
];
function harness({
  supported = true,
  sponsored = true,
  attempts = 1,
  auth = {},
} = {}) {
  const calls: Array<{ method: string; args: any }> = [];
  const results: any[] = [];
  const current: any = {
    id: "volume-id",
    name: "home",
    owner_account_id: "owner-not-payer",
    funding_mode: "account-prepaid",
    state: "ready",
    ...(sponsored
      ? {
          funding_source: source,
          funding_status: {
            source,
            payer_account_id: source.payer_account_id,
            label: "Independent course storage",
            state: "running",
            funding_version: "volume-epoch",
            as_of: new Date().toISOString(),
            authorized_until: new Date(Date.now() + 3600000).toISOString(),
            storage_delete_at: new Date(Date.now() + 7200000).toISOString(),
          },
        }
      : {}),
  };
  const api: any = {
    getCatalog: async () => ({ sponsored_home_volumes: supported }),
    getVolume: async () => current,
  };
  for (const method of [
    "createVolume",
    "resizeVolume",
    "deleteVolume",
    "setVolumeFundingMode",
    "createVm",
  ])
    api[method] = async (args: any) => {
      calls.push({ method, args });
      return current;
    };
  const program = new Command().exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerVmCommand(program, {
    progress: () => {},
    withContext: async (_command, _name, fn) => {
      for (let i = 0; i < attempts; i++)
        results.push(
          await fn({
            globals: {},
            remote: { user: auth },
            hub: { compute: api },
          } as any),
        );
    },
  });
  return {
    current,
    calls,
    results,
    api,
    run: (...args: string[]) =>
      program.parseAsync(["node", "cocalc", "vm", ...args]),
  };
}

it("volume create sends explicit course payer and retention with a stable retry key", async () => {
  const h = harness({ attempts: 2 });
  await h.run(
    "volume",
    "create",
    "home",
    ...flags,
    "--accept-course-retention",
  );
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0].args.funding_source, source);
  assert.equal(h.calls[0].args.accept_course_retention, true);
  assert.equal(
    h.calls[0].args.idempotency_key,
    h.calls[1].args.idempotency_key,
  );
});
it("partial UUIDs, malformed UUIDs, and missing retention never create", async () => {
  for (const args of [
    ["--funding-payer", source.payer_account_id],
    ["--funding-payer", "bad", ...flags.slice(2), "--accept-course-retention"],
    flags,
  ]) {
    const h = harness();
    await assert.rejects(h.run("volume", "create", "home", ...args));
    assert.equal(h.calls.length, 0);
  }
});
it("unsupported sponsored creation is blocked before a mutation", async () => {
  const h = harness({ supported: false });
  await assert.rejects(
    h.run("volume", "create", "home", ...flags, "--accept-course-retention"),
    /unavailable on this server/,
  );
  assert.equal(h.calls.length, 0);
});
it("backend rejection never retries as personally funded", async () => {
  const h = harness();
  h.api.createVolume = async (args: any) => {
    h.calls.push({ method: "createVolume", args });
    throw Error("rollout disabled");
  };
  await assert.rejects(
    h.run("volume", "create", "home", ...flags, "--accept-course-retention"),
    /rollout disabled/,
  );
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].args.funding_source, source);
});
it("legacy personal creation needs no capability or retention", async () => {
  const h = harness({ supported: false, sponsored: false });
  await h.run("volume", "create", "home");
  assert.equal(h.calls[0].args.funding_source, undefined);
  assert.equal(h.calls[0].args.accept_course_retention, undefined);
});
it("status reports independent owner, payer and retention without mutation", async () => {
  const h = harness();
  await h.run("volume", "funding", "home");
  assert.equal(h.results[0].owner_account_id, "owner-not-payer");
  assert.deepEqual(h.results[0].funding_status, h.current.funding_status);
  assert.equal(h.calls.length, 0);
});
it("version-only returns a raw usable version, not an approval action", async () => {
  const h = harness();
  await h.run("volume", "funding", "home", "--version-only");
  assert.equal(h.results[0], "volume-epoch");
  assert.equal(h.calls.length, 0);
});
it("unknown, stale, expired, protected or incomplete-source status cannot supply a usable version", async () => {
  for (const patch of [
    undefined,
    { as_of: "2000-01-01" },
    { authorized_until: "2000-01-01" },
    { state: "stopped" },
    { state: "protected" },
    { stop_at: "2000-01-01" },
    { stop_at: "invalid" },
    { funding_version: "" },
    { source: undefined },
    { source: { ...source, pool_id: undefined } },
    { source: { ...source, grant_id: undefined } },
  ]) {
    const h = harness();
    h.current.funding_status = patch
      ? { ...h.current.funding_status, ...patch }
      : undefined;
    await assert.rejects(
      h.run("volume", "funding", "home", "--version-only"),
      /funding is unavailable/,
    );
    assert.equal(h.calls.length, 0);
  }
});
it("redacted public payer supports status, reviewed resize and independent VM attachment", async () => {
  const h = harness();
  const publicSource = {
    kind: source.kind,
    pool_id: source.pool_id,
    grant_id: source.grant_id,
  };
  h.current.funding_source = publicSource;
  h.current.funding_status = {
    ...h.current.funding_status,
    source: publicSource,
    payer_account_id: undefined,
    label: "Course funding",
    state: "ready",
    stop_at: new Date(Date.now() + 3600000).toISOString(),
  };
  await h.run("volume", "funding", "home");
  assert.equal(h.results[0].funding_status.label, "Course funding");
  assert.equal(h.results[0].funding_status.source.payer_account_id, undefined);
  await h.run("volume", "funding", "home", "--version-only");
  assert.equal(h.results[1], "volume-epoch");
  await h.run(
    "volume",
    "resize",
    "home",
    "--size-gb",
    "100",
    "--expected-funding-version",
    "volume-epoch",
  );
  await h.run(
    "create",
    "cpu",
    "--home-volume",
    "home",
    "--home-volume-funding-version",
    "volume-epoch",
  );
  assert.deepEqual(
    h.calls.map(({ method }) => method),
    ["resizeVolume", "createVm"],
  );
  assert.equal(h.calls[0].args.expected_funding_version, "volume-epoch");
  assert.equal(
    h.calls[1].args.expected_home_volume_funding_version,
    "volume-epoch",
  );
  assert.equal(h.calls[1].args.funding_source, undefined);
});
it("course lane cannot be changed through legacy --set", async () => {
  const h = harness();
  await assert.rejects(
    h.run("volume", "funding", "home", "--set", "account-postpaid"),
    /separate approved handoff/,
  );
  assert.equal(h.calls.length, 0);
});
it("resize requires the reviewed version and preserves payer", async () => {
  const h = harness({ attempts: 2 });
  await h.run(
    "volume",
    "resize",
    "home",
    "--size-gb",
    "100",
    "--expected-funding-version",
    "volume-epoch",
  );
  assert.equal(h.calls[0].args.expected_funding_version, "volume-epoch");
  assert.equal(h.calls[0].args.funding_source, undefined);
  assert.equal(
    h.calls[0].args.idempotency_key,
    h.calls[1].args.idempotency_key,
  );
});
it("resize blocks unreviewed epochs, unknown status, unsupported backend and lane changes", async () => {
  for (const mode of ["missing", "stale", "unsupported", "lane"]) {
    const h = harness({ supported: mode !== "unsupported" });
    if (mode === "stale") h.current.funding_status = undefined;
    await assert.rejects(
      h.run(
        "volume",
        "resize",
        "home",
        "--size-gb",
        "100",
        ...(mode === "lane" ? ["--funding-mode", "account-postpaid"] : []),
      ),
    );
    assert.equal(h.calls.length, 0);
  }
});
it("personal VM attachment keeps separately sponsored storage's reviewed epoch", async () => {
  const h = harness();
  await h.run(
    "create",
    "cpu",
    "--home-volume",
    "home",
    "--home-volume-funding-version",
    "volume-epoch",
  );
  assert.equal(h.calls[0].method, "createVm");
  assert.equal(
    h.calls[0].args.expected_home_volume_funding_version,
    "volume-epoch",
  );
  assert.equal(h.calls[0].args.funding_source, undefined);
});
it("attachment blocks missing or mismatched epochs before VM creation", async () => {
  for (const extra of [[], ["--home-volume-funding-version", "other-epoch"]]) {
    const h = harness();
    await assert.rejects(
      h.run("create", "cpu", "--home-volume", "home", ...extra),
      /Review vm volume funding/,
    );
    assert.equal(h.calls.length, 0);
  }
});
it("deletion stays available despite unavailable funding and retains exact confirmation", async () => {
  const h = harness({ supported: false, attempts: 2 });
  h.current.funding_status = undefined;
  await h.run("volume", "delete", "home", "--confirm", "home");
  assert.equal(h.calls[0].args.confirm_name, "home");
  assert.equal(
    h.calls[0].args.idempotency_key,
    h.calls[1].args.idempotency_key,
  );
});
it("ambient project credentials cannot create sponsored home volumes", async () => {
  const h = harness({ auth: { project_id: "project" } });
  await assert.rejects(
    h.run("volume", "create", "home", ...flags, "--accept-course-retention"),
    /account/i,
  );
  assert.equal(h.calls.length, 0);
});
it("agent proposals retain backend approval requirements without an approval bypass", async () => {
  const h = harness({
    auth: { auth_actor: "agent", auth_project_id: "project" },
  });
  h.api.createVolume = async (args: any) => {
    h.calls.push({ method: "createVolume", args });
    throw Error("owner approval required");
  };
  await assert.rejects(
    h.run("volume", "create", "home", ...flags, "--accept-course-retention"),
    /owner approval/,
  );
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].args.funding_source, source);
});
