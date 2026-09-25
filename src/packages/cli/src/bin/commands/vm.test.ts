/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Command } from "commander";
import {
  buildVmSshConfigBlock,
  isTransientVmPollError,
  parseTtlMinutes,
  scheduledStopOptions,
  courseFundingSource,
  registerVmCommand,
  removeVmSshConfigBlock,
  resolveVmRsyncEndpoint,
  vmListSummary,
  vmLifecycleSummary,
  vmRsyncArgs,
  vmWaitProgress,
  volumeListSummary,
} from "./vm";

describe("scheduled stop options", () => {
  it("distinguishes omitted, explicit disabled, and a duration", () => {
    assert.deepEqual(scheduledStopOptions({}), {});
    assert.deepEqual(scheduledStopOptions({ scheduledStop: false }), {
      stop_after_minutes: null,
    });
    assert.deepEqual(scheduledStopOptions({ stopAfter: "6h" }), {
      stop_after_minutes: 360,
    });
    assert.throws(
      () => scheduledStopOptions({ stopAfter: "6h", scheduledStop: false }),
      /cannot be combined/,
    );
    for (const stopAfter of ["0m", "-1h", "366d", "never"])
      assert.throws(() => scheduledStopOptions({ stopAfter }));
  });
  it("passes the stop choice through the existing start command", async () => {
    const { program, stateCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "start",
      "timer",
      "--stop-after",
      "2h",
    ]);
    assert.equal(stateCalls[0].opts.stop_after_minutes, 120);
  });
});

describe("course VM funding flags", () => {
  const payer = "10000000-0000-4000-8000-000000000001";
  const pool = "10000000-0000-4000-8000-000000000002";
  const grant = "10000000-0000-4000-8000-000000000003";
  it("requires all three UUIDs and leaves omitted personal funding unchanged", () => {
    assert.equal(courseFundingSource({}), undefined);
    for (let mask = 1; mask < 7; mask++) {
      assert.throws(
        () =>
          courseFundingSource({
            fundingPayer: mask & 1 ? payer : undefined,
            fundingPool: mask & 2 ? pool : undefined,
            fundingGrant: mask & 4 ? grant : undefined,
          }),
        /required together/,
      );
    }
    assert.throws(
      () =>
        courseFundingSource({
          fundingPayer: "bad",
          fundingPool: pool,
          fundingGrant: grant,
        }),
      /UUID/,
    );
  });
  it("passes the full source to the existing create API", async () => {
    const { program, createCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "create",
      "funded-vm",
      "--funding-payer",
      payer,
      "--funding-pool",
      pool,
      "--funding-grant",
      grant,
    ]);
    assert.deepEqual(createCalls[0].funding_source, {
      kind: "course",
      payer_account_id: payer,
      pool_id: pool,
      grant_id: grant,
    });
  });
  it("rejects incomplete funding before any create request", async () => {
    const { program, createCalls } = harness();
    await assert.rejects(
      program.parseAsync([
        "node",
        "cocalc",
        "vm",
        "create",
        "funded-vm",
        "--funding-pool",
        pool,
      ]),
      /required together/,
    );
    assert.equal(createCalls.length, 0);
  });
});

function harness(
  opts: {
    projectId?: string;
    projectAuth?: boolean;
    agentAuth?: boolean;
    callbackAttempts?: number;
  } = {},
) {
  const sshCalls: string[][] = [];
  const rsyncCalls: string[][] = [];
  const callbackResults: unknown[] = [];
  const ttlCalls: any[] = [];
  const createCalls: any[] = [];
  const machineCalls: any[] = [];
  const progressMessages: string[] = [];
  const sshAuthorizationCalls: any[] = [];
  const projectSshAuthorizationCalls: any[] = [];
  const listCalls: any[] = [];
  const projectListCalls: any[] = [];
  const catalogCalls: any[] = [];
  const accessListCalls: any[] = [];
  const accessGrantCalls: any[] = [];
  const accessRevokeCalls: any[] = [];
  const rdpCalls: any[] = [];
  const stateCalls: Array<{ action: "start" | "stop"; opts: any }> = [];
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerVmCommand(program, {
    withContext: async (_command, _name, callback) => {
      let result: unknown;
      for (let attempt = 0; attempt < (opts.callbackAttempts ?? 1); attempt++) {
        result = await callback({
          globals: {},
          remote: {
            user: opts.agentAuth
              ? { auth_actor: "agent", auth_project_id: opts.projectId }
              : opts.projectAuth
                ? { project_id: opts.projectId }
                : {},
          },
          hub: {
            compute: {
              getCatalog: async (callOpts: any) => {
                catalogCalls.push(callOpts);
                return {
                  provider_catalogs: { gcp: { entries: [] } },
                  defaults: { provider: "gcp" },
                  limits: { max_active_per_account: 3 },
                  funding_modes: [],
                };
              },
              listVms: async (callOpts: any) => {
                listCalls.push(callOpts);
                return [];
              },
              listProjectVms: async (callOpts: any) => {
                projectListCalls.push(callOpts);
                return [];
              },
              listVmProjectAccess: async (callOpts: any) => {
                accessListCalls.push(callOpts);
                return [];
              },
              grantVmProjectAccess: async (callOpts: any) => {
                accessGrantCalls.push(callOpts);
                return { ...callOpts, state: "pending" };
              },
              revokeVmProjectAccess: async (callOpts: any) => {
                accessRevokeCalls.push(callOpts);
                return { ...callOpts, state: "revoking" };
              },
              getVm: async () => ({
                id: "vm-id",
                name: "build-vm",
                state: "ready",
                public_ip: "203.0.113.10",
                ssh_user: "user",
                operating_system: "windows",
              }),
              authorizeSshKey: async (opts: any) => {
                sshAuthorizationCalls.push(opts);
                return {
                  id: "vm-id",
                  name: "build-vm",
                  state: "ready",
                  public_ip: "203.0.113.10",
                  ssh_user: "user",
                  operating_system: "windows",
                };
              },
              authorizeProjectSshKey: async (callOpts: any) => {
                projectSshAuthorizationCalls.push(callOpts);
                return {
                  id: "vm-id",
                  name: "build-vm",
                  state: "ready",
                  public_ip: "203.0.113.10",
                  ssh_user: "user",
                  operating_system: "windows",
                };
              },
              createVm: async (opts: any) => {
                createCalls.push(opts);
                return { id: "vm-id", name: opts.name, state: "requested" };
              },
              startVm: async (opts: any) => {
                stateCalls.push({ action: "start", opts });
                return {
                  id: "vm-id",
                  name: "build-vm",
                  state: "starting",
                  desired_state: "running",
                  metadata: { provider_internal: true },
                };
              },
              stopVm: async (opts: any) => {
                stateCalls.push({ action: "stop", opts });
                return {
                  id: "vm-id",
                  name: "build-vm",
                  state: "stopping",
                  desired_state: "stopped",
                  metadata: { provider_internal: true },
                };
              },
              setVmTtl: async (opts: any) => {
                ttlCalls.push(opts);
                return { id: "vm-id", name: "build-vm", ...opts };
              },
              setVmMachineType: async (opts: any) => {
                machineCalls.push(opts);
                return {
                  id: "vm-id",
                  name: "build-vm",
                  state: "stopped",
                  machine_type: opts.machine_type,
                };
              },
              prepareWindowsRdp: async (callOpts: any) => {
                rdpCalls.push(callOpts);
                return {
                  id: "vm-id",
                  name: "build-vm",
                  hostname: "vm.example.test",
                  ssh_user: "user",
                  windows_user: "user",
                  windows_password: "temporary-password",
                  remote_port: 3389,
                };
              },
            },
          },
        });
      }
      callbackResults.push(result);
      return result;
    },
    progress: (message) => progressMessages.push(message),
    runSsh: (args) => sshCalls.push(args),
    runRsync: (args) => rsyncCalls.push(args),
    resolvePublicKey: (path) => ({
      path: path ?? "/home/test/.ssh/id_ed25519.pub",
      key: "ssh-ed25519 AAAATEST test@example.com",
    }),
    resolveProjectId: () => opts.projectId,
  });
  return {
    program,
    sshCalls,
    rsyncCalls,
    callbackResults,
    ttlCalls,
    createCalls,
    machineCalls,
    progressMessages,
    sshAuthorizationCalls,
    projectSshAuthorizationCalls,
    listCalls,
    projectListCalls,
    catalogCalls,
    accessListCalls,
    accessGrantCalls,
    accessRevokeCalls,
    rdpCalls,
    stateCalls,
  };
}

describe("vm project access", () => {
  it("lists access grants for one account-owned VM", async () => {
    const { program, accessListCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "access",
      "list",
      "build-vm",
      "--include-revoked",
    ]);
    assert.deepEqual(accessListCalls, [
      { id_or_name: "build-vm", include_revoked: true },
    ]);
  });

  it("grants and revokes project access with idempotency keys", async () => {
    const { program, accessGrantCalls, accessRevokeCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "access",
      "grant",
      "build-vm",
      "--project",
      "project-id",
    ]);
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "access",
      "revoke",
      "build-vm",
      "--project",
      "project-id",
    ]);
    assert.equal(accessGrantCalls[0]?.id_or_name, "build-vm");
    assert.equal(accessGrantCalls[0]?.project_id, "project-id");
    assert.match(accessGrantCalls[0]?.idempotency_key, /^[0-9a-f-]{36}$/);
    assert.equal(accessRevokeCalls[0]?.id_or_name, "build-vm");
    assert.equal(accessRevokeCalls[0]?.project_id, "project-id");
    assert.match(accessRevokeCalls[0]?.idempotency_key, /^[0-9a-f-]{36}$/);
  });

  it("rejects project-scoped authentication", async () => {
    const { program } = harness({
      projectId: "project-id",
      projectAuth: true,
    });
    await assert.rejects(
      program.parseAsync(["node", "cocalc", "vm", "access", "list"]),
      /account authentication/,
    );
  });
});

describe("vm catalog", () => {
  it("queries and selects the live provider catalog", async () => {
    const { program, catalogCalls, callbackResults } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "catalog",
      "--provider",
      "gcp",
    ]);
    assert.deepEqual(catalogCalls, [{}]);
    assert.deepEqual(callbackResults[0], {
      provider: "gcp",
      catalog: { entries: [] },
      defaults: { provider: "gcp" },
      limits: { max_active_per_account: 3 },
      funding_modes: [],
    });
  });
});

describe("vm list scope", () => {
  it("defaults project authentication to the current project", async () => {
    const { program, listCalls, projectListCalls } = harness({
      projectId: "project-id",
      projectAuth: true,
    });
    await program.parseAsync(["node", "cocalc", "vm", "list"]);
    assert.equal(projectListCalls.length, 1);
    assert.equal(listCalls.length, 0);
  });

  it("uses the project-scoped listing for agent authentication", async () => {
    const { program, listCalls, projectListCalls } = harness({
      projectId: "project-id",
      agentAuth: true,
    });
    await program.parseAsync(["node", "cocalc", "vm", "list"]);
    assert.equal(projectListCalls.length, 1);
    assert.equal(listCalls.length, 0);
  });

  it("uses COCALC_PROJECT_ID as the account-authenticated default filter", async () => {
    const { program, listCalls, projectListCalls } = harness({
      projectId: "project-id",
    });
    await program.parseAsync(["node", "cocalc", "vm", "list"]);
    assert.deepEqual(projectListCalls, [
      { project_id: "project-id", include_deleted: false },
    ]);
    assert.equal(listCalls.length, 0);
  });

  it("uses the collaborator-aware listing for an explicit project", async () => {
    const { program, listCalls, projectListCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "list",
      "--project",
      "project-id",
    ]);
    assert.deepEqual(projectListCalls, [
      { project_id: "project-id", include_deleted: false },
    ]);
    assert.equal(listCalls.length, 0);
  });

  it("lists the whole account only when account authentication is available", async () => {
    const { program, listCalls } = harness({ projectId: "project-id" });
    await program.parseAsync(["node", "cocalc", "vm", "list", "--all"]);
    assert.equal(listCalls[0]?.project_id, undefined);
  });
});

describe("vm availability", () => {
  it("allows a project agent to start and stop existing VMs", async () => {
    const { program, stateCalls } = harness({
      projectId: "project-id",
      agentAuth: true,
    });
    await program.parseAsync(["node", "cocalc", "vm", "start", "build-vm"]);
    await program.parseAsync(["node", "cocalc", "vm", "stop", "build-vm"]);
    assert.deepEqual(
      stateCalls.map(({ action, opts }) => ({
        action,
        id_or_name: opts.id_or_name,
      })),
      [
        { action: "start", id_or_name: "build-vm" },
        { action: "stop", id_or_name: "build-vm" },
      ],
    );
  });

  it("keeps one mutation identity while waiting for agent approval", async () => {
    const { program, stateCalls } = harness({
      projectId: "project-id",
      agentAuth: true,
      callbackAttempts: 2,
    });
    await program.parseAsync(["node", "cocalc", "vm", "stop", "build-vm"]);
    assert.equal(stateCalls.length, 2);
    assert.equal(
      stateCalls[0].opts.idempotency_key,
      stateCalls[1].opts.idempotency_key,
    );
  });

  it("summarizes lifecycle results without internal provider metadata", () => {
    assert.deepEqual(
      vmLifecycleSummary({
        id: "vm-id",
        name: "build-vm",
        state: "ready",
        desired_state: "running",
        provider: "gcp",
        machine_type: "e2-standard-2",
        operating_system: "linux",
        effective_pricing_model: "spot",
        zone: "us-west1-a",
        public_hostname: "vm.example.test",
        public_ip: "203.0.113.10",
        ssh_alias: "build-vm",
        expires_at: null,
        metadata: { large: "internal record" },
      }),
      {
        id: "vm-id",
        name: "build-vm",
        state: "ready",
        desired_state: "running",
        provider: "gcp",
        machine: "e2-standard-2",
        os: "Linux",
        pricing: "Spot",
        zone: "us-west1-a",
        hostname: "vm.example.test",
        ip: "203.0.113.10",
        ssh_alias: "build-vm",
        expires: "never",
        stops: "never",
        stop_after_minutes: null,
      },
    );
  });

  it("uses compact lifecycle output unless --long is requested", async () => {
    const compact = harness();
    await compact.program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "start",
      "build-vm",
    ]);
    assert.equal("metadata" in (compact.callbackResults[0] as object), false);
    assert.match(compact.progressMessages[0], /Requesting start/);

    const full = harness();
    await full.program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "start",
      "build-vm",
      "--long",
    ]);
    assert.deepEqual((full.callbackResults[0] as any).metadata, {
      provider_internal: true,
    });
  });
});

describe("vm create", () => {
  it("creates an account-owned VM without a project grant", async () => {
    const { program, createCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "create",
      "account-vm",
      "--no-ssh-key",
    ]);
    assert.equal(createCalls[0]?.project_id, undefined);
    assert.equal(createCalls[0]?.configure_project_ssh, false);
  });

  it("defaults to the attached project's deploy key", async () => {
    const { program, createCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "create",
      "project-key",
      "--project",
      "project-id",
    ]);
    assert.equal(createCalls[0]?.ssh_public_key, undefined);
    assert.equal(createCalls[0]?.configure_project_ssh, true);
    assert.equal(createCalls[0]?.gpu_count, undefined);
    assert.equal(createCalls[0]?.operating_system, "linux");
  });

  it("passes an explicit fixed GPU count", async () => {
    const { program, createCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "create",
      "l4-vm",
      "--project",
      "project-id",
      "--machine",
      "g2-standard-4",
      "--gpu-type",
      "nvidia-l4",
      "--gpu-count",
      "1",
    ]);
    assert.equal(createCalls[0]?.gpu_count, 1);
  });

  it("passes an explicit Nebius provider platform", async () => {
    const { program, createCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "create",
      "h200-vm",
      "--provider",
      "nebius",
      "--machine",
      "1gpu-16vcpu-200gb",
      "--provider-platform",
      "gpu-h200-sxm",
    ]);
    assert.deepEqual(createCalls[0]?.provider_spec, {
      platform: "gpu-h200-sxm",
    });
  });

  it("creates Windows with its safer boot-disk default", async () => {
    const { program, createCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "create",
      "windows-vm",
      "--project",
      "project-id",
      "--os",
      "windows",
    ]);
    assert.equal(createCalls[0]?.operating_system, "windows");
    assert.equal(createCalls[0]?.boot_disk_gb, 80);
  });

  it("can deliberately create without an initial SSH key", async () => {
    const { program, createCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "create",
      "keyless",
      "--project",
      "project-id",
      "--no-ssh-key",
    ]);
    assert.equal(createCalls[0]?.ssh_public_key, "");
    assert.equal(createCalls[0]?.configure_project_ssh, false);
  });

  it("accepts the literal public key shown by the web UI", async () => {
    const { program, createCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "create",
      "inline-key",
      "--project",
      "project-id",
      "--ssh-public-key-value",
      "ssh-ed25519 AAAAUSER user@example.com",
    ]);
    assert.equal(
      createCalls[0]?.ssh_public_key,
      "ssh-ed25519 AAAAUSER user@example.com",
    );
    assert.equal(createCalls[0]?.configure_project_ssh, true);
  });

  it("can use a custom key without maintaining the project SSH alias", async () => {
    const { program, createCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "create",
      "custom-key",
      "--project",
      "project-id",
      "--ssh-public-key-value",
      "ssh-ed25519 AAAAUSER user@example.com",
      "--no-configure-project-ssh",
    ]);
    assert.equal(createCalls[0]?.configure_project_ssh, false);
  });

  it("reports when provider provisioning is queued", async () => {
    const { program, progressMessages } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "create",
      "status-vm",
      "--project",
      "project-id",
      "--zone",
      "us-west1-a",
      "--machine",
      "e2-standard-2",
      "--no-ssh-key",
    ]);
    assert.deepEqual(progressMessages, [
      "[vm create] Submitting 'status-vm' (gcp, linux, e2-standard-2, us-west1-a)...",
      "[vm create] Provider provisioning queued for 'status-vm' (id vm-id).",
    ]);
  });
});

describe("vm ttl", () => {
  it("parses human durations and extends an existing deadline", async () => {
    assert.equal(parseTtlMinutes("2h"), 120);
    const { program, ttlCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "ttl",
      "build-vm",
      "--extend",
      "2h",
    ]);
    assert.equal(ttlCalls[0]?.id_or_name, "build-vm");
    assert.equal(ttlCalls[0]?.extend_minutes, 120);
    assert.equal(typeof ttlCalls[0]?.idempotency_key, "string");
  });

  it("clears the deadline explicitly", async () => {
    const { program, ttlCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "ttl",
      "build-vm",
      "--clear",
    ]);
    assert.equal(ttlCalls[0]?.ttl_minutes, null);
  });
});

describe("vm machine", () => {
  it("changes the machine type through the account control plane", async () => {
    const { program, machineCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "machine",
      "build-vm",
      "n2d-standard-8",
    ]);
    assert.equal(machineCalls[0]?.id_or_name, "build-vm");
    assert.equal(machineCalls[0]?.machine_type, "n2d-standard-8");
    assert.equal(typeof machineCalls[0]?.idempotency_key, "string");
  });
});

describe("vm ssh", () => {
  it("opens an interactive SSH session when no command is supplied", async () => {
    const { program, sshCalls, callbackResults, sshAuthorizationCalls } =
      harness();
    await program.parseAsync(["node", "cocalc", "vm", "ssh", "build-vm"]);
    assert.deepEqual(sshCalls[0]?.slice(-1), ["user@203.0.113.10"]);
    assert.equal(
      sshAuthorizationCalls[0]?.ssh_public_key,
      "ssh-ed25519 AAAATEST test@example.com",
    );
    assert.deepEqual(callbackResults, [undefined]);
  });

  it("authorizes SSH through the current project identity", async () => {
    const projectId = "af027aca-e308-41c2-b528-a3e73de50996";
    const { program, projectSshAuthorizationCalls, sshAuthorizationCalls } =
      harness({ projectId, projectAuth: true });
    await program.parseAsync(["node", "cocalc", "vm", "ssh", "build-vm"]);
    assert.equal(projectSshAuthorizationCalls[0]?.project_id, projectId);
    assert.equal(
      projectSshAuthorizationCalls[0]?.ssh_public_key,
      "ssh-ed25519 AAAATEST test@example.com",
    );
    assert.equal(sshAuthorizationCalls.length, 0);
  });

  it("passes a remote command and option-like arguments through to SSH", async () => {
    const { program, sshCalls, callbackResults } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "ssh",
      "build-vm",
      "ls",
      "-la",
    ]);
    assert.deepEqual(sshCalls[0]?.slice(-3), [
      "user@203.0.113.10",
      "ls",
      "-la",
    ]);
    assert.deepEqual(callbackResults, [undefined]);
  });
});

describe("vm rdp", () => {
  it("returns a private tunnel and freshly rotated credentials", async () => {
    const { program, callbackResults, rdpCalls } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "rdp",
      "build-vm",
      "--local-port",
      "14489",
    ]);

    assert.equal(rdpCalls[0]?.id_or_name, "vm-id");
    assert.deepEqual(callbackResults[0], {
      id: "vm-id",
      name: "build-vm",
      rdp_address: "127.0.0.1:14489",
      username: "user",
      password: "temporary-password",
      tunnel_command:
        'ssh "-N" "-o" "ExitOnForwardFailure=yes" "-L" "14489:127.0.0.1:3389" "-o" "ForwardAgent=no" "-o" "StrictHostKeyChecking=accept-new" "user@203.0.113.10"',
      note: "TCP 3389 is not public. Keep the SSH tunnel open while using RDP.",
    });
  });
});

describe("vm rsync", () => {
  it("passes ordinary rsync options and resolves a destination VM", async () => {
    const { program, rsyncCalls, callbackResults } = harness();
    await program.parseAsync([
      "node",
      "cocalc",
      "vm",
      "rsync",
      "-az",
      "./src/",
      "build-vm:/home/user/src/",
    ]);
    assert.deepEqual(rsyncCalls[0]?.slice(-3), [
      "-az",
      "./src/",
      "user@203.0.113.10:/home/user/src/",
    ]);
    assert.deepEqual(callbackResults, [undefined]);
  });

  it("resolves a source VM endpoint", () => {
    const args = vmRsyncArgs(
      {
        id: "vm-id",
        name: "build-vm",
        state: "ready",
        public_ip: "203.0.113.10",
        ssh_user: "user",
      },
      ["-a", "build-vm:/home/user/dist/", "./dist/"],
      {},
    );
    assert.equal(args.at(-2), "user@203.0.113.10:/home/user/dist/");
    assert.equal(
      resolveVmRsyncEndpoint(["build-vm:/home/user", "."]).vm,
      "build-vm",
    );
  });

  it("rejects remote-to-remote and transport overrides", () => {
    assert.throws(
      () => resolveVmRsyncEndpoint(["one:/home/user", "two:/home/user"]),
      /exactly one VM endpoint/,
    );
    assert.throws(
      () =>
        vmRsyncArgs(
          {
            id: "vm-id",
            name: "build-vm",
            state: "ready",
            public_ip: "203.0.113.10",
          },
          ["-e", "ssh -A", ".", "build-vm:/home/user"],
          {},
        ),
      /use --identity/,
    );
  });
});

describe("vm list", () => {
  it("uses a compact operational summary by default", () => {
    assert.deepEqual(
      vmListSummary([
        {
          id: "vm-id",
          name: "build-vm",
          state: "ready",
          machine_type: "e2-standard-2",
          effective_pricing_model: "spot",
          zone: "us-central1-a",
          public_ip: "203.0.113.10",
          expires_at: "2026-08-04T00:00:00.000Z",
          project_id: "project-id",
          metadata: { deliberately: "omitted" },
        },
      ]),
      [
        {
          name: "build-vm",
          state: "ready",
          machine: "e2-standard-2",
          os: "Linux",
          pricing: "Spot",
          zone: "us-central1-a",
          ip: "203.0.113.10",
          expires: "2026-08-04T00:00:00.000Z",
          stops: "never",
          project: "project-id",
        },
      ],
    );
  });
});

describe("vm wait", () => {
  it("retries transient hub socket failures but not provider failures", () => {
    assert.equal(
      isTransientVmPollError(new Error("socket has been disconnected")),
      true,
    );
    assert.equal(
      isTransientVmPollError(new Error("connection closed before reply")),
      true,
    );
    assert.equal(
      isTransientVmPollError(new Error("provider provisioning failed")),
      false,
    );
  });

  it("explains retryable Spot capacity recovery", () => {
    assert.match(
      vmWaitProgress({
        state: "recovering",
        zone: "us-central1-a",
        error: "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS",
        spot_recovery_state: {},
      }) ?? "",
      /Spot capacity is unavailable in us-central1-a; retrying automatically/,
    );
    assert.equal(vmWaitProgress({ state: "ready" }), undefined);
  });
});

describe("vm volume list", () => {
  it("uses a compact storage summary by default", () => {
    assert.deepEqual(
      volumeListSummary([
        {
          name: "build-cache",
          state: "ready",
          size_gb: 50,
          zone: "us-central1-a",
          attachment_state: "detached",
          attached_vm_id: null,
          monthly_price_per_gb: "0.100000",
        },
      ]),
      [
        {
          name: "build-cache",
          state: "ready",
          size_gb: 50,
          zone: "us-central1-a",
          attachment: "detached",
          vm: "",
          monthly_usd: 5,
        },
      ],
    );
  });
});

describe("vm ssh-config", () => {
  it("replaces only the matching managed block", () => {
    const oldBlock = buildVmSshConfigBlock({
      alias: "build-vm",
      hostname: "203.0.113.1",
      username: "user",
      identity: "/home/user/.ssh/id_ed25519",
    });
    const content = `Host personal\n  HostName example.com\n\n${oldBlock}`;
    const removed = removeVmSshConfigBlock(content, "build-vm");
    assert.equal(removed.removed, true);
    assert.match(removed.content, /Host personal/);
    assert.doesNotMatch(removed.content, /203\.0\.113\.1/);
  });

  it("writes a locked-down direct SSH entry", () => {
    const block = buildVmSshConfigBlock({
      alias: "build-vm",
      hostname: "203.0.113.10",
      username: "user",
      identity: "/home/user/.ssh/id_ed25519",
    });
    assert.match(block, /Host build-vm/);
    assert.match(block, /HostName 203\.0\.113\.10/);
    assert.match(block, /ForwardAgent no/);
    assert.match(block, /IdentitiesOnly yes/);
    assert.match(block, /StrictHostKeyChecking accept-new/);
  });
});
