/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Command } from "commander";

export type VmCommandDeps = {
  withContext: any;
  progress?: (message: string) => void;
  runSsh?: (args: string[]) => void;
  runRsync?: (args: string[]) => void;
  resolvePublicKey?: (path?: string) => { path?: string; key: string };
  resolveProjectId?: () => string | undefined;
};

function projectIdFromEnvironment() {
  const projectId = `${process.env.COCALC_PROJECT_ID ?? ""}`.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    projectId,
  )
    ? projectId
    : undefined;
}

function expandHome(path: string) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function readPublicKey(path?: string) {
  const candidates = path
    ? [expandHome(path)]
    : [
        resolve(homedir(), ".ssh/id_ed25519.pub"),
        resolve(homedir(), ".ssh/id_rsa.pub"),
        resolve(homedir(), ".ssh/id_ecdsa.pub"),
      ];
  const selected = candidates.find(existsSync);
  if (!selected) {
    throw new Error(
      "no SSH public key found; create ~/.ssh/id_ed25519.pub or pass --ssh-public-key",
    );
  }
  return { path: selected, key: readFileSync(selected, "utf8").trim() };
}

function normalizeSshConfigAlias(value: string) {
  const alias = `${value ?? ""}`.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(alias)) {
    throw new Error(`ssh config alias '${alias}' must match [a-zA-Z0-9._-]+`);
  }
  return alias;
}

function sshConfigPath(path?: string) {
  return path ? expandHome(path) : resolve(homedir(), ".ssh/config");
}

function defaultIdentityPath(path?: string) {
  if (path) {
    const selected = expandHome(path);
    if (!existsSync(selected))
      throw new Error(`SSH identity not found: ${selected}`);
    return selected;
  }
  return ["id_ed25519", "id_rsa", "id_ecdsa"]
    .map((name) => resolve(homedir(), `.ssh/${name}`))
    .find(existsSync);
}

function sshConfigMarkers(alias: string) {
  return {
    start: `# >>> cocalc vm ssh ${alias} >>>`,
    end: `# <<< cocalc vm ssh ${alias} <<<`,
  };
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function removeVmSshConfigBlock(content: string, alias: string) {
  const { start, end } = sshConfigMarkers(alias);
  const pattern = new RegExp(
    `(?:^|\\n)${escapeRegExp(start)}\\n[\\s\\S]*?\\n${escapeRegExp(end)}(?:\\n|$)`,
    "g",
  );
  const next = content.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
  return { content: next, removed: next !== content };
}

export function buildVmSshConfigBlock(opts: {
  alias: string;
  hostname: string;
  username: string;
  identity?: string;
}) {
  const markers = sshConfigMarkers(opts.alias);
  const lines = [
    markers.start,
    `Host ${opts.alias}`,
    `  HostName ${opts.hostname}`,
    `  User ${opts.username}`,
    "  ForwardAgent no",
    "  StrictHostKeyChecking accept-new",
    "  ServerAliveInterval 15",
    "  ServerAliveCountMax 2",
  ];
  if (opts.identity) {
    lines.push(`  IdentityFile ${opts.identity}`, "  IdentitiesOnly yes");
  }
  lines.push(
    "  BatchMode yes",
    "  PreferredAuthentications publickey",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    markers.end,
  );
  return `${lines.join("\n")}\n`;
}

export function parseTtlMinutes(value: string) {
  const match = `${value ?? ""}`.trim().match(/^(\d+)(m|h|d)$/i);
  if (!match)
    throw new Error("--ttl must use minutes, hours, or days, e.g. 30m or 8h");
  const count = Number(match[1]);
  const multiplier =
    match[2].toLowerCase() === "m"
      ? 1
      : match[2].toLowerCase() === "h"
        ? 60
        : 1440;
  return count * multiplier;
}

async function waitForState(
  getVm: (idOrName: string) => Promise<any>,
  idOrName: string,
  desired: Set<string>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  let lastProgress = "";
  let transientPollFailures = 0;
  while (Date.now() < deadline) {
    try {
      last = await getVm(idOrName);
      transientPollFailures = 0;
    } catch (err) {
      if (!isTransientVmPollError(err)) throw err;
      transientPollFailures += 1;
      await new Promise((resolvePromise) =>
        setTimeout(
          resolvePromise,
          Math.min(10_000, 1000 * transientPollFailures),
        ),
      );
      continue;
    }
    if (desired.has(last.state)) return last;
    if (last.state === "failed") {
      throw new Error(last.error || `compute VM '${idOrName}' failed`);
    }
    const progress = vmWaitProgress(last);
    if (progress && progress !== lastProgress) {
      process.stderr.write(`[vm wait] ${progress}\n`);
      lastProgress = progress;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
  }
  throw new Error(
    `timed out waiting for compute VM '${idOrName}'; last state=${last?.state ?? "unknown"}`,
  );
}

export function isTransientVmPollError(err: unknown) {
  const code = `${(err as any)?.code ?? ""}`;
  if (code === "503" || code === "408") return true;
  const message = `${err ?? ""}`.toLowerCase();
  return (
    message.includes("server is busy") ||
    message.includes("api server is busy") ||
    message.includes("timeout") ||
    message.includes("socket has been disconnected") ||
    message.includes("socket is disconnected") ||
    message.includes("connection closed") ||
    /once: .* not emitted before "closed"/i.test(message)
  );
}

function projectScopedAuthId(ctx: any): string | undefined {
  const projectId = `${
    ctx?.remote?.user?.project_id ?? ctx?.remote?.user?.auth_project_id ?? ""
  }`.trim();
  return projectId || undefined;
}

function requireAccountAuth(ctx: any, action: string) {
  if (ctx?.remote?.user?.auth_actor === "agent") return;
  if (projectScopedAuthId(ctx)) {
    throw Object.assign(
      new Error(
        `${action} requires account authentication instead of the ambient project credential`,
      ),
      { code: "account_auth_required" },
    );
  }
}

async function getVmForContext(ctx: any, idOrName: string) {
  return projectScopedAuthId(ctx)
    ? await ctx.hub.compute.getProjectVm({ id_or_name: idOrName })
    : await ctx.hub.compute.getVm({ id_or_name: idOrName });
}

async function getVolumeForContext(ctx: any, idOrName: string) {
  return projectScopedAuthId(ctx)
    ? await ctx.hub.compute.getProjectVolume({ id_or_name: idOrName })
    : await ctx.hub.compute.getVolume({ id_or_name: idOrName });
}

export function vmWaitProgress(vm: any): string | undefined {
  if (vm?.state !== "recovering") return;
  const error = `${vm?.error ?? ""}`.toUpperCase();
  const retryAt = vm?.spot_recovery_state?.next_retry_at;
  if (
    error.includes("ZONE_RESOURCE_POOL_EXHAUSTED") ||
    error.includes("RESOURCE_POOL_EXHAUSTED") ||
    error.includes("INSUFFICIENT CAPACITY")
  ) {
    const when = retryAt
      ? `; next attempt ${new Date(retryAt).toLocaleTimeString()}`
      : "";
    return `Spot capacity is unavailable in ${vm.zone}; retrying automatically${when}`;
  }
  return "VM recovery is in progress; waiting for SSH readiness";
}

async function waitForVolumeState(
  getVolume: (idOrName: string) => Promise<any>,
  idOrName: string,
  desired: Set<string>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  let transientPollFailures = 0;
  while (Date.now() < deadline) {
    try {
      last = await getVolume(idOrName);
      transientPollFailures = 0;
    } catch (err) {
      if (!isTransientVmPollError(err)) throw err;
      transientPollFailures += 1;
      await new Promise((resolvePromise) =>
        setTimeout(
          resolvePromise,
          Math.min(10_000, 1000 * transientPollFailures),
        ),
      );
      continue;
    }
    if (desired.has(last.state)) return last;
    if (last.state === "failed") {
      throw new Error(last.error || `compute volume '${idOrName}' failed`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
  }
  throw new Error(
    `timed out waiting for compute volume '${idOrName}'; last state=${last?.state ?? "unknown"}`,
  );
}

function sshArgs(vm: any, opts: { identity?: string }, command?: string[]) {
  if (!vm.public_ip || vm.state !== "ready") {
    throw new Error(
      `compute VM '${vm.name}' is not SSH-ready (state=${vm.state})`,
    );
  }
  const args = [
    "-o",
    "ForwardAgent=no",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  if (opts.identity) args.push("-i", expandHome(opts.identity));
  args.push(`${vm.ssh_user || "user"}@${vm.public_hostname || vm.public_ip}`);
  if (command?.length) args.push(...command);
  return args;
}

function defaultRunSsh(args: string[]) {
  const result = spawnSync("ssh", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if ((result.status ?? 0) !== 0) {
    throw new Error(`ssh exited with code ${result.status}`);
  }
}

function defaultRunRsync(args: string[]) {
  const result = spawnSync("rsync", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if ((result.status ?? 0) !== 0) {
    throw new Error(`rsync exited with code ${result.status}`);
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolveVmRsyncEndpoint(args: string[]) {
  const candidates = args.flatMap((arg, index) => {
    if (arg.startsWith("-")) return [];
    const match = arg.match(/^([a-z][a-z0-9-]{0,31}):(.*)$/);
    return match ? [{ index, vm: match[1], path: match[2] }] : [];
  });
  if (candidates.length !== 1) {
    throw new Error(
      "rsync requires exactly one VM endpoint, e.g. vm-name:/home/user/data",
    );
  }
  return candidates[0];
}

export function vmRsyncArgs(
  vm: any,
  args: string[],
  opts: { identity?: string },
) {
  if (!vm.public_ip || vm.state !== "ready") {
    throw new Error(
      `compute VM '${vm.name}' is not SSH-ready (state=${vm.state})`,
    );
  }
  if (args.some((arg) => arg === "-e" || arg.startsWith("--rsh"))) {
    throw new Error(
      "use --identity instead of overriding rsync's SSH transport",
    );
  }
  const endpoint = resolveVmRsyncEndpoint(args);
  if (endpoint.vm !== vm.name && endpoint.vm !== vm.id) {
    throw new Error(`resolved VM '${vm.name}' does not match '${endpoint.vm}'`);
  }
  const ssh = [
    "ssh",
    "-o",
    "ForwardAgent=no",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  if (opts.identity) ssh.push("-i", expandHome(opts.identity));
  const next = [...args];
  next[endpoint.index] =
    `${vm.ssh_user || "user"}@${vm.public_hostname || vm.public_ip}:${endpoint.path}`;
  return ["-e", ssh.map(shellQuote).join(" "), ...next];
}

export function vmListSummary(rows: any[]) {
  return rows.map((row) => ({
    name: row.name,
    state: row.state,
    machine: row.machine_type,
    os:
      (row.operating_system ?? "linux") === "windows"
        ? "Windows 2022"
        : "Linux",
    pricing: row.effective_pricing_model === "spot" ? "Spot" : "Standard",
    zone: row.zone,
    ip: row.public_ip ?? "",
    expires: row.expires_at ?? "never",
    project: row.project_id,
  }));
}

export function volumeListSummary(rows: any[]) {
  return rows.map((row) => ({
    name: row.name,
    state: row.state,
    size_gb: row.size_gb,
    zone: row.zone,
    attachment: row.attachment_state,
    vm: row.attached_vm_id ?? "",
    monthly_usd: Number(row.size_gb) * Number(row.monthly_price_per_gb),
  }));
}

export function registerVmCommand(program: Command, deps: VmCommandDeps) {
  const {
    withContext,
    progress = (message) => process.stderr.write(`${message}\n`),
    runSsh = defaultRunSsh,
    runRsync = defaultRunRsync,
    resolvePublicKey = readPublicKey,
    resolveProjectId = projectIdFromEnvironment,
  } = deps;
  const authorizeSsh = async (
    ctx: any,
    idOrName: string,
    opts: { identity?: string; sshPublicKey?: string },
  ) => {
    const publicKeyPath =
      opts.sshPublicKey ??
      (opts.identity ? `${expandHome(opts.identity)}.pub` : undefined);
    const key = resolvePublicKey(publicKeyPath);
    const projectId = projectScopedAuthId(ctx);
    const authorize = projectId
      ? ctx.hub.compute.authorizeProjectSshKey
      : ctx.hub.compute.authorizeSshKey;
    return await authorize({
      ...(projectId ? { project_id: projectId } : {}),
      id_or_name: idOrName,
      ssh_public_key: key.key,
      idempotency_key: randomUUID(),
    });
  };
  const vm = program
    .command("vm")
    .description("account-owned managed compute VMs");

  vm.command("catalog")
    .description("show the live managed-compute provider catalog")
    .option("--provider <provider>", "limit output to gcp or nebius")
    .action(async (opts: { provider?: string }, command: Command) => {
      await withContext(command, "vm catalog", async (ctx) => {
        requireAccountAuth(ctx, "vm catalog");
        const catalog = await ctx.hub.compute.getCatalog({});
        if (!opts.provider) return catalog;
        if (opts.provider !== "gcp" && opts.provider !== "nebius") {
          throw new Error("provider must be gcp or nebius");
        }
        return {
          provider: opts.provider,
          catalog: catalog.provider_catalogs[opts.provider],
          defaults: catalog.defaults,
          limits: catalog.limits,
          funding_modes: catalog.funding_modes,
        };
      });
    });

  vm.command("list")
    .description("list managed compute VMs in project or account scope")
    .option("--project <project_id>", "filter by attached project")
    .option("--include-deleted", "include deleted lease records", false)
    .option("--all", "list all VMs owned by the authenticated account", false)
    .option("--long", "show the full durable VM records", false)
    .action(
      async (
        opts: {
          project?: string;
          includeDeleted?: boolean;
          long?: boolean;
          all?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "vm list", async (ctx) => {
          const ambientProjectId = resolveProjectId();
          const authProjectId = projectScopedAuthId(ctx);
          if (opts.all && opts.project) {
            throw new Error("use only one of --all or --project");
          }
          if (opts.all) requireAccountAuth(ctx, "vm list --all");
          const requestedProjectId = opts.all
            ? undefined
            : (opts.project ?? ambientProjectId);
          if (
            authProjectId &&
            requestedProjectId &&
            requestedProjectId !== authProjectId
          ) {
            throw new Error(
              `project-scoped authentication can only list VMs for ${authProjectId}`,
            );
          }
          const rows = authProjectId
            ? await ctx.hub.compute.listProjectVms({
                include_deleted: opts.includeDeleted === true,
              })
            : await ctx.hub.compute.listVms({
                project_id: requestedProjectId,
                include_deleted: opts.includeDeleted === true,
              });
          return opts.long ? rows : vmListSummary(rows);
        });
      },
    );

  vm.command("get <vm>")
    .description("inspect an owned compute VM")
    .action(async (idOrName: string, command: Command) => {
      await withContext(command, "vm get", async (ctx) => {
        return await getVmForContext(ctx, idOrName);
      });
    });

  vm.command("orphans")
    .description("list managed-compute provider orphans (admin only)")
    .option("--include-resolved", "include resolved orphan observations", false)
    .action(async (opts: { includeResolved?: boolean }, command: Command) => {
      await withContext(command, "vm orphans", async (ctx) => {
        requireAccountAuth(ctx, "vm orphans");
        return await ctx.hub.compute.listOrphans({
          include_resolved: opts.includeResolved === true,
        });
      });
    });

  vm.command("orphan-resolve <orphan-id>")
    .description(
      "stop, delete, or ignore a managed-compute orphan (admin only)",
    )
    .requiredOption("--action <action>", "stop, delete, or ignore")
    .action(
      async (
        orphanId: string,
        opts: { action: "stop" | "delete" | "ignore" },
        command: Command,
      ) => {
        await withContext(command, "vm orphan-resolve", async (ctx) => {
          requireAccountAuth(ctx, "vm orphan-resolve");
          return await ctx.hub.compute.resolveOrphan({
            orphan_id: orphanId,
            action: opts.action,
          });
        });
      },
    );

  vm.command("create <name>")
    .description("create a managed compute VM")
    .requiredOption("--project <project_id>", "attached CoCalc project")
    .option("--provider <provider>", "gcp or nebius", "gcp")
    .option("--os <operating_system>", "linux or windows", "linux")
    .option("--region <region>", "provider region", "us-central1")
    .option("--zone <zone>", "provider zone")
    .option("--architecture <arch>", "x86_64 or arm64", "x86_64")
    .option(
      "--machine <machine_type>",
      "allowlisted machine type",
      "e2-standard-2",
    )
    .option("--spot", "use interruptible Spot capacity", false)
    .option(
      "--allow-standard-fallback",
      "authorize 24-hour Standard fallback when Spot is unavailable",
      false,
    )
    .option("--ttl <duration>", "optional deletion deadline, e.g. 30m or 8h")
    .option("--boot-disk-gb <gb>", "persistent root disk size")
    .option(
      "--home-volume <name>",
      "existing persistent volume mounted at /home/user",
    )
    .option("--gpu-type <type>", "provider GPU type")
    .option("--gpu-count <count>", "number of GPUs")
    .option(
      "--funding-mode <mode>",
      "site-funded, account-postpaid, or account-prepaid",
    )
    .option(
      "--no-configure-project-ssh",
      "do not maintain this VM's alias in the attached project's SSH config",
    )
    .option("--ssh-public-key <path>", "OpenSSH public key file")
    .option("--ssh-public-key-value <key>", "literal OpenSSH public key")
    .option(
      "--no-ssh-key",
      "create without an initial key; cocalc vm ssh can authorize one later",
    )
    .option("--wait", "wait until SSH-ready", false)
    .action(async (name: string, opts: any, command: Command) => {
      await withContext(command, "vm create", async (ctx) => {
        requireAccountAuth(ctx, "vm create");
        const keySources = [
          opts.sshPublicKey ? "path" : "",
          opts.sshPublicKeyValue ? "value" : "",
          opts.sshKey === false ? "none" : "",
        ].filter(Boolean);
        if (keySources.length > 1) {
          throw new Error(
            "use only one of --ssh-public-key, --ssh-public-key-value, or --no-ssh-key",
          );
        }
        const key =
          opts.sshKey === false
            ? { key: "", path: undefined }
            : opts.sshPublicKeyValue
              ? { key: `${opts.sshPublicKeyValue}`.trim(), path: undefined }
              : opts.sshPublicKey
                ? resolvePublicKey(opts.sshPublicKey)
                : { key: undefined, path: undefined };
        progress(
          `[vm create] Submitting '${name}' (${opts.provider}, ${opts.os}, ${opts.machine}, ${opts.zone ?? opts.region})...`,
        );
        const created = await ctx.hub.compute.createVm({
          project_id: opts.project,
          name,
          provider: opts.provider,
          operating_system: opts.os,
          funding_mode: opts.fundingMode,
          architecture: opts.architecture,
          region: opts.region,
          zone: opts.zone,
          machine_type: opts.machine,
          gpu_type:
            opts.gpuType && opts.gpuType !== "none" ? opts.gpuType : undefined,
          gpu_count: opts.gpuCount == null ? undefined : Number(opts.gpuCount),
          pricing_model: opts.spot ? "spot" : "on_demand",
          allow_on_demand_fallback: opts.allowStandardFallback === true,
          ttl_minutes: opts.ttl ? parseTtlMinutes(opts.ttl) : null,
          boot_disk_gb: Number(
            opts.bootDiskGb ?? (opts.os === "windows" ? 80 : 20),
          ),
          home_volume: opts.homeVolume,
          ssh_public_key: key.key,
          configure_project_ssh:
            opts.sshKey !== false && opts.configureProjectSsh !== false,
          idempotency_key: randomUUID(),
        });
        progress(
          `[vm create] Provider provisioning queued for '${name}' (id ${created.id}).`,
        );
        if (!opts.wait) {
          return {
            ...created,
            ...(key.path ? { ssh_public_key_path: key.path } : {}),
          };
        }
        progress(`[vm create] Waiting for '${name}' to become SSH-ready...`);
        return {
          ...(await waitForState(
            (vm) => getVmForContext(ctx, vm),
            created.id,
            new Set(["ready"]),
            opts.os === "windows" ? 15 * 60_000 : 5 * 60_000,
          )),
          ...(key.path ? { ssh_public_key_path: key.path } : {}),
        };
      });
    });

  vm.command("wait <vm>")
    .description("wait for a VM to become SSH-ready")
    .option("--timeout <seconds>", "maximum wait", "300")
    .action(
      async (idOrName: string, opts: { timeout: string }, command: Command) => {
        await withContext(command, "vm wait", async (ctx) => {
          return await waitForState(
            (vm) => getVmForContext(ctx, vm),
            idOrName,
            new Set(["ready"]),
            Number(opts.timeout) * 1000,
          );
        });
      },
    );

  vm.command("ttl <vm>")
    .description("show, set, extend, or clear a VM deletion deadline")
    .option("--set <duration>", "set a deadline from now, e.g. 8h")
    .option("--extend <duration>", "extend the current deadline, e.g. 2h")
    .option("--clear", "remove the optional deletion deadline")
    .action(async (idOrName: string, opts: any, command: Command) => {
      await withContext(command, "vm ttl", async (ctx) => {
        const selected = [
          opts.set != null,
          opts.extend != null,
          opts.clear,
        ].filter(Boolean).length;
        if (selected === 0) {
          const current = await getVmForContext(ctx, idOrName);
          return {
            id: current.id,
            name: current.name,
            expires_at: current.expires_at ?? null,
          };
        }
        if (selected !== 1) {
          throw new Error("specify exactly one of --set, --extend, or --clear");
        }
        requireAccountAuth(ctx, "changing a VM deletion deadline");
        return await ctx.hub.compute.setVmTtl({
          id_or_name: idOrName,
          ...(opts.extend != null
            ? { extend_minutes: parseTtlMinutes(opts.extend) }
            : {
                ttl_minutes:
                  opts.set != null ? parseTtlMinutes(opts.set) : null,
              }),
          idempotency_key: randomUUID(),
        });
      });
    });

  vm.command("funding <vm>")
    .description("show or change a VM funding lane")
    .option("--set <mode>", "site-funded, account-postpaid, or account-prepaid")
    .action(
      async (idOrName: string, opts: { set?: string }, command: Command) => {
        await withContext(command, "vm funding", async (ctx) => {
          const current = await getVmForContext(ctx, idOrName);
          if (!opts.set) {
            return {
              id: current.id,
              name: current.name,
              funding_mode: current.funding_mode,
            };
          }
          requireAccountAuth(ctx, "changing a VM funding lane");
          return await ctx.hub.compute.setVmFundingMode({
            id_or_name: idOrName,
            funding_mode: opts.set,
            idempotency_key: randomUUID(),
          });
        });
      },
    );

  vm.command("machine <vm> [machine_type]")
    .description("show or change the machine type of a stopped VM")
    .action(
      async (
        idOrName: string,
        machineType: string | undefined,
        _opts: unknown,
        command: Command,
      ) => {
        await withContext(command, "vm machine", async (ctx) => {
          const current = await getVmForContext(ctx, idOrName);
          if (!machineType) {
            return {
              id: current.id,
              name: current.name,
              state: current.state,
              machine_type: current.machine_type,
            };
          }
          requireAccountAuth(ctx, "changing a VM machine type");
          return await ctx.hub.compute.setVmMachineType({
            id_or_name: idOrName,
            machine_type: machineType,
            idempotency_key: randomUUID(),
          });
        });
      },
    );

  for (const action of ["start", "stop"] as const) {
    vm.command(`${action} <vm>`)
      .description(`${action} an owned compute VM inside its existing lease`)
      .option(
        "--wait",
        `wait for ${action === "start" ? "ready" : "stopped"}`,
        false,
      )
      .action(
        async (
          idOrName: string,
          opts: { wait?: boolean },
          command: Command,
        ) => {
          await withContext(command, `vm ${action}`, async (ctx) => {
            requireAccountAuth(ctx, `vm ${action}`);
            const result = await ctx.hub.compute[`${action}Vm`]({
              id_or_name: idOrName,
              idempotency_key: randomUUID(),
            });
            if (!opts.wait) return result;
            return await waitForState(
              (vm) => getVmForContext(ctx, vm),
              result.id,
              new Set([action === "start" ? "ready" : "stopped"]),
              5 * 60_000,
            );
          });
        },
      );
  }

  vm.command("delete <vm>")
    .description("delete a VM lease and its persistent root disk")
    .option("--wait", "wait for provider deletion", false)
    .action(
      async (idOrName: string, opts: { wait?: boolean }, command: Command) => {
        await withContext(command, "vm delete", async (ctx) => {
          requireAccountAuth(ctx, "vm delete");
          const result = await ctx.hub.compute.deleteVm({
            id_or_name: idOrName,
            idempotency_key: randomUUID(),
          });
          if (!opts.wait) return result;
          return await waitForState(
            (vm) => getVmForContext(ctx, vm),
            result.id,
            new Set(["deleted"]),
            5 * 60_000,
          );
        });
      },
    );

  vm.command("ssh <vm> [remote_command...]")
    .description(
      "connect directly to a compute VM, or run a remote command after the VM name",
    )
    .option("--identity <path>", "SSH private key")
    .option("--ssh-public-key <path>", "public key matching the SSH identity")
    .option("--print", "print the SSH command instead of running it", false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(
      async (
        idOrName: string,
        remoteCommand: string[],
        opts: { identity?: string; sshPublicKey?: string; print?: boolean },
        command: Command,
      ) => {
        await withContext(command, "vm ssh", async (ctx) => {
          const row = await authorizeSsh(ctx, idOrName, opts);
          const args = sshArgs(row, opts, remoteCommand);
          const rendered = `ssh ${args.map((arg) => JSON.stringify(arg)).join(" ")}`;
          if (opts.print || ctx.globals.json || ctx.globals.output === "json") {
            return { id: row.id, name: row.name, command: rendered };
          }
          runSsh(args);
          // SSH owns stdout/stderr. Returning data here would add a CLI result
          // table after the interactive session or remote command completes.
          return undefined;
        });
      },
    );

  vm.command("rdp <vm>")
    .description(
      "rotate a Windows login password and print a private RDP-over-SSH tunnel",
    )
    .option("--identity <path>", "SSH private key")
    .option("--ssh-public-key <path>", "public key matching the SSH identity")
    .option("--local-port <port>", "localhost port for the tunnel", "13389")
    .option("--tunnel", "run the SSH tunnel in the foreground", false)
    .action(async (idOrName: string, opts: any, command: Command) => {
      await withContext(command, "vm rdp", async (ctx) => {
        requireAccountAuth(ctx, "vm rdp");
        const row = await authorizeSsh(ctx, idOrName, opts);
        if ((row.operating_system ?? "linux") !== "windows") {
          throw new Error(`compute VM '${row.name}' is not a Windows VM`);
        }
        const localPort = Number(opts.localPort);
        if (
          !Number.isInteger(localPort) ||
          localPort < 1024 ||
          localPort > 65535
        ) {
          throw new Error("--local-port must be an integer from 1024 to 65535");
        }
        const prepared = await ctx.hub.compute.prepareWindowsRdp({
          id_or_name: row.id,
        });
        const tunnelArgs = sshArgs(row, opts);
        tunnelArgs.unshift(
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          "-L",
          `${localPort}:127.0.0.1:${prepared.remote_port}`,
        );
        const tunnelCommand = `ssh ${tunnelArgs
          .map((arg) => JSON.stringify(arg))
          .join(" ")}`;
        const result = {
          id: row.id,
          name: row.name,
          rdp_address: `127.0.0.1:${localPort}`,
          username: prepared.windows_user,
          password: prepared.windows_password,
          tunnel_command: tunnelCommand,
          note: "TCP 3389 is not public. Keep the SSH tunnel open while using RDP.",
        };
        if (!opts.tunnel) return result;
        process.stderr.write(
          `[vm rdp] Connect your RDP client to ${result.rdp_address}\n` +
            `[vm rdp] Username: ${result.username}\n` +
            `[vm rdp] One-time displayed password: ${result.password}\n` +
            "[vm rdp] Starting the private SSH tunnel; press Ctrl-C to stop it.\n",
        );
        runSsh(tunnelArgs);
        return undefined;
      });
    });

  vm.command("rsync <rsync_args...>")
    .description(
      "copy files with rsync; exactly one endpoint must be vm-name:/path",
    )
    .option("--identity <path>", "SSH private key")
    .option("--ssh-public-key <path>", "public key matching the SSH identity")
    .option("--print", "print the rsync command instead of running it", false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(
      async (
        rsyncArgs: string[],
        opts: { identity?: string; sshPublicKey?: string; print?: boolean },
        command: Command,
      ) => {
        await withContext(command, "vm rsync", async (ctx) => {
          const endpoint = resolveVmRsyncEndpoint(rsyncArgs);
          const row = await authorizeSsh(ctx, endpoint.vm, opts);
          const args = vmRsyncArgs(row, rsyncArgs, opts);
          const rendered = `rsync ${args.map(shellQuote).join(" ")}`;
          if (opts.print || ctx.globals.json || ctx.globals.output === "json") {
            return { id: row.id, name: row.name, command: rendered };
          }
          runRsync(args);
          return undefined;
        });
      },
    );

  const volume = vm
    .command("volume")
    .description("manage persistent account-owned home volumes");

  volume
    .command("list")
    .description("list persistent compute volumes")
    .option("--include-deleted", "include deleted volume records", false)
    .option(
      "--all",
      "list all volumes owned by the authenticated account",
      false,
    )
    .option("--long", "show full durable volume records", false)
    .action(async (opts: any, command: Command) => {
      await withContext(command, "vm volume list", async (ctx) => {
        const ambientProjectId = resolveProjectId();
        const authProjectId = projectScopedAuthId(ctx);
        if (opts.all) requireAccountAuth(ctx, "vm volume list --all");
        const rows = authProjectId
          ? await ctx.hub.compute.listProjectVolumes({
              include_deleted: opts.includeDeleted === true,
            })
          : await ctx.hub.compute.listVolumes({
              project_id: opts.all ? undefined : ambientProjectId,
              include_deleted: opts.includeDeleted === true,
            });
        return opts.long ? rows : volumeListSummary(rows);
      });
    });

  volume
    .command("get <volume>")
    .description("inspect a persistent compute volume")
    .action(async (idOrName: string, command: Command) => {
      await withContext(command, "vm volume get", async (ctx) => {
        return await getVolumeForContext(ctx, idOrName);
      });
    });

  volume
    .command("create <name>")
    .description("create a persistent /home/user volume")
    .requiredOption("--project <project_id>", "attached CoCalc project")
    .option("--provider <provider>", "gcp or nebius", "gcp")
    .option("--region <region>", "provider region", "us-central1")
    .option("--zone <zone>", "provider zone")
    .option("--size-gb <gb>", "volume size", "50")
    .option(
      "--funding-mode <mode>",
      "site-funded, account-postpaid, or account-prepaid",
    )
    .option("--wait", "wait until the volume is ready", false)
    .action(async (name: string, opts: any, command: Command) => {
      await withContext(command, "vm volume create", async (ctx) => {
        requireAccountAuth(ctx, "vm volume create");
        const created = await ctx.hub.compute.createVolume({
          project_id: opts.project,
          name,
          provider: opts.provider,
          region: opts.region,
          zone: opts.zone,
          size_gb: Number(opts.sizeGb),
          funding_mode: opts.fundingMode,
          idempotency_key: randomUUID(),
        });
        if (!opts.wait) return created;
        return await waitForVolumeState(
          (volume) => getVolumeForContext(ctx, volume),
          created.id,
          new Set(["ready"]),
          5 * 60_000,
        );
      });
    });

  volume
    .command("resize <volume>")
    .description("grow a persistent compute volume")
    .requiredOption("--size-gb <gb>", "new grow-only volume size")
    .option(
      "--funding-mode <mode>",
      "site-funded, account-postpaid, or account-prepaid",
    )
    .option("--wait", "wait until provider resize completes", false)
    .action(async (idOrName: string, opts: any, command: Command) => {
      await withContext(command, "vm volume resize", async (ctx) => {
        requireAccountAuth(ctx, "vm volume resize");
        const resized = await ctx.hub.compute.resizeVolume({
          id_or_name: idOrName,
          size_gb: Number(opts.sizeGb),
          funding_mode: opts.fundingMode,
          idempotency_key: randomUUID(),
        });
        if (!opts.wait) return resized;
        return await waitForVolumeState(
          (volume) => getVolumeForContext(ctx, volume),
          resized.id,
          new Set(["ready"]),
          5 * 60_000,
        );
      });
    });

  volume
    .command("funding <volume>")
    .description("show or change a persistent home volume funding lane")
    .option("--set <mode>", "site-funded, account-postpaid, or account-prepaid")
    .action(
      async (idOrName: string, opts: { set?: string }, command: Command) => {
        await withContext(command, "vm volume funding", async (ctx) => {
          const current = await getVolumeForContext(ctx, idOrName);
          if (!opts.set) {
            return {
              id: current.id,
              name: current.name,
              funding_mode: current.funding_mode,
            };
          }
          requireAccountAuth(ctx, "changing a home volume funding lane");
          return await ctx.hub.compute.setVolumeFundingMode({
            id_or_name: idOrName,
            funding_mode: opts.set,
            idempotency_key: randomUUID(),
          });
        });
      },
    );

  volume
    .command("delete <volume>")
    .description("permanently delete a detached persistent volume")
    .requiredOption("--confirm <name>", "type the exact volume name")
    .option("--wait", "wait for provider deletion", false)
    .action(async (idOrName: string, opts: any, command: Command) => {
      await withContext(command, "vm volume delete", async (ctx) => {
        requireAccountAuth(ctx, "vm volume delete");
        const deleted = await ctx.hub.compute.deleteVolume({
          id_or_name: idOrName,
          confirm_name: opts.confirm,
          idempotency_key: randomUUID(),
        });
        if (!opts.wait) return deleted;
        return await waitForVolumeState(
          (volume) => getVolumeForContext(ctx, volume),
          deleted.id,
          new Set(["deleted"]),
          5 * 60_000,
        );
      });
    });

  const sshConfig = vm
    .command("ssh-config")
    .description("manage local OpenSSH config entries for compute VMs");

  sshConfig
    .command("add <vm>")
    .description("add or update a managed ~/.ssh/config entry")
    .option("--alias <alias>", "SSH Host alias (defaults to the VM name)")
    .option("--identity <path>", "SSH private key")
    .option("--ssh-public-key <path>", "public key matching the SSH identity")
    .option("--config <path>", "SSH config path (default: ~/.ssh/config)")
    .action(async (idOrName: string, opts: any, command: Command) => {
      await withContext(command, "vm ssh-config add", async (ctx) => {
        const row = await authorizeSsh(ctx, idOrName, opts);
        if (!row.public_ip || row.state !== "ready") {
          throw new Error(
            `compute VM '${row.name}' is not SSH-ready (state=${row.state})`,
          );
        }
        const alias = normalizeSshConfigAlias(opts.alias ?? row.name);
        const configPath = sshConfigPath(opts.config);
        const identity = defaultIdentityPath(opts.identity);
        const existing = existsSync(configPath)
          ? readFileSync(configPath, "utf8")
          : "";
        const stripped = removeVmSshConfigBlock(
          existing,
          alias,
        ).content.trimEnd();
        const block = buildVmSshConfigBlock({
          alias,
          hostname: row.public_hostname || row.public_ip,
          username: row.ssh_user || "user",
          identity,
        });
        mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
        writeFileSync(
          configPath,
          stripped ? `${stripped}\n\n${block}` : block,
          {
            encoding: "utf8",
            mode: 0o600,
          },
        );
        return {
          id: row.id,
          name: row.name,
          alias,
          config_path: configPath,
          identity: identity ?? null,
          command: `ssh ${alias}`,
        };
      });
    });

  sshConfig
    .command("remove <alias>")
    .description("remove a managed compute VM entry from ~/.ssh/config")
    .option("--config <path>", "SSH config path (default: ~/.ssh/config)")
    .action(async (aliasValue: string, opts: any, command: Command) => {
      await withContext(command, "vm ssh-config remove", async () => {
        const alias = normalizeSshConfigAlias(aliasValue);
        const configPath = sshConfigPath(opts.config);
        if (!existsSync(configPath)) {
          return { alias, config_path: configPath, removed: false };
        }
        const stripped = removeVmSshConfigBlock(
          readFileSync(configPath, "utf8"),
          alias,
        );
        if (stripped.removed) {
          writeFileSync(configPath, `${stripped.content.trimEnd()}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
        }
        return { alias, config_path: configPath, removed: stripped.removed };
      });
    });

  return vm;
}
