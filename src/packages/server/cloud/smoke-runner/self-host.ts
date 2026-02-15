/*
Smoke test for self-host project hosts via Multipass.

What it does:
1. Launches a fresh Multipass VM with your local SSH public key.
2. Creates a self-host host record that points to that VM over SSH.
3. Starts the host and waits for running.
4. Creates/starts a project on that host.
5. Writes a sentinel file.
6. Creates a backup and waits until an indexed snapshot is visible.
7. Optionally verifies the sentinel file is browseable in backup index.
8. Optionally creates a second VM host, moves the project there, and verifies
   the sentinel file is restored and readable on the destination host.
9. Optionally deprovisions all created hosts.

Typical usage from a node REPL:

  a = require("../../dist/cloud/smoke-runner/self-host");
  await a.runSelfHostMultipassBackupSmoke({});
*/

import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import admins from "@cocalc/server/accounts/admins";
import {
  createProject,
  moveProject,
  start as startProject,
} from "@cocalc/server/conat/api/projects";
import {
  createBackup as createProjectBackup,
  getBackupFiles,
  getBackups,
  restoreBackup as restoreProjectBackup,
} from "@cocalc/server/conat/api/project-backups";
import {
  createHost,
  deleteHost,
  deleteHostInternal,
  startHostInternal,
} from "@cocalc/server/conat/api/hosts";
import deleteProject from "@cocalc/server/projects/delete";
import { conatWithProjectRouting } from "@cocalc/server/conat/route-client";
import { fsClient, fsSubject } from "@cocalc/conat/files/fs";

const logger = getLogger("server:cloud:smoke-runner:self-host");
const execFile = promisify(execFileCb);

type WaitOptions = {
  intervalMs: number;
  attempts: number;
};

type StepResult = {
  name: string;
  status: "ok" | "failed";
  started_at: string;
  finished_at: string;
  error?: string;
};

type LogEvent = {
  step: string;
  status: "start" | "ok" | "failed";
  message?: string;
};

export type SelfHostMultipassSmokeOptions = {
  account_id?: string;
  vm_name?: string;
  vm_image?: string;
  vm_user?: string;
  vm_cpus?: number;
  vm_memory_gb?: number;
  vm_disk_gb?: number;
  ssh_public_key_path?: string;
  cleanup_on_success?: boolean;
  cleanup_on_failure?: boolean;
  verify_deprovision?: boolean;
  verify_backup_index_contents?: boolean;
  verify_move_restore_on_second_host?: boolean;
  wait?: Partial<{
    ssh_ready: Partial<WaitOptions>;
    host_running: Partial<WaitOptions>;
    host_deprovisioned: Partial<WaitOptions>;
    backup_indexed: Partial<WaitOptions>;
    move_completed: Partial<WaitOptions>;
    restored_file: Partial<WaitOptions>;
  }>;
  log?: (event: LogEvent) => void;
};

export type SelfHostMultipassSmokeResult = {
  ok: boolean;
  account_id: string;
  vm_name: string;
  vm_ip?: string;
  ssh_target?: string;
  host_id?: string;
  second_vm_name?: string;
  second_vm_ip?: string;
  second_ssh_target?: string;
  second_host_id?: string;
  project_id?: string;
  backup_id?: string;
  backup_op_id?: string;
  move_op_id?: string;
  restore_op_id?: string;
  sentinel_path: string;
  sentinel_value: string;
  steps: StepResult[];
  error?: string;
  debug_hints: {
    host_log: string;
    project_host_log: string;
    backup_log: string;
  };
};

const DEFAULT_SSH_READY_WAIT: WaitOptions = { intervalMs: 2000, attempts: 90 };
const DEFAULT_HOST_RUNNING_WAIT: WaitOptions = { intervalMs: 5000, attempts: 120 };
const DEFAULT_BACKUP_INDEXED_WAIT: WaitOptions = {
  intervalMs: 3000,
  attempts: 80,
};
const DEFAULT_MOVE_COMPLETED_WAIT: WaitOptions = {
  intervalMs: 3000,
  attempts: 120,
};
const DEFAULT_RESTORED_FILE_WAIT: WaitOptions = {
  intervalMs: 2000,
  attempts: 90,
};
const DEFAULT_HOST_DEPROVISIONED_WAIT: WaitOptions = {
  intervalMs: 5000,
  attempts: 120,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveWait(
  override: Partial<WaitOptions> | undefined,
  fallback: WaitOptions,
): WaitOptions {
  return {
    intervalMs: override?.intervalMs ?? fallback.intervalMs,
    attempts: override?.attempts ?? fallback.attempts,
  };
}

async function resolveSmokeAccountId(account_id?: string): Promise<string> {
  if (account_id) return account_id;
  const ids = await admins();
  if (!ids.length) {
    throw new Error(
      "no admin account found; pass account_id explicitly or create an admin account",
    );
  }
  return ids[0];
}

function quoteYamlSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function resolveSshPublicKey(pathHint?: string): Promise<string> {
  const candidates = [
    pathHint,
    process.env.SSH_PUBLIC_KEY_PATH,
    join(homedir(), ".ssh", "id_ed25519.pub"),
    join(homedir(), ".ssh", "id_rsa.pub"),
  ].filter(Boolean) as string[];
  for (const path of candidates) {
    try {
      const key = (await readFile(path, "utf8")).trim();
      if (key) {
        return key;
      }
    } catch {}
  }
  throw new Error(
    "unable to read local SSH public key; set ssh_public_key_path or create ~/.ssh/id_ed25519.pub",
  );
}

async function runCommand(
  command: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile(command, args, {
      timeout: opts.timeoutMs,
      cwd: opts.cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: `${stdout ?? ""}`.trim(),
      stderr: `${stderr ?? ""}`.trim(),
    };
  } catch (err: any) {
    const stderr = `${err?.stderr ?? ""}`.trim();
    const stdout = `${err?.stdout ?? ""}`.trim();
    const parts = [
      `${command} ${args.join(" ")}`.trim(),
      err?.message ? `message=${err.message}` : undefined,
      stdout ? `stdout=${stdout}` : undefined,
      stderr ? `stderr=${stderr}` : undefined,
    ].filter(Boolean);
    throw new Error(parts.join(" | "));
  }
}

async function requireCommand(name: string): Promise<void> {
  await runCommand("which", [name]);
}

async function getMultipassIp(vmName: string): Promise<string> {
  const { stdout } = await runCommand("multipass", [
    "info",
    vmName,
    "--format",
    "json",
  ]);
  const parsed = JSON.parse(stdout);
  const info = parsed?.info?.[vmName];
  const ips = Array.isArray(info?.ipv4) ? info.ipv4 : [];
  const ip = ips.find((x: any) => typeof x === "string" && x.trim());
  if (!ip) {
    throw new Error(`could not determine ipv4 for multipass vm '${vmName}'`);
  }
  return ip;
}

async function waitForSshReady({
  sshTarget,
  wait,
}: {
  sshTarget: string;
  wait: WaitOptions;
}): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    try {
      await runCommand(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          "ConnectTimeout=5",
          sshTarget,
          "true",
        ],
        { timeoutMs: 15_000 },
      );
      return;
    } catch (err) {
      lastErr = err;
      logger.debug("self-host smoke ssh wait retry", {
        sshTarget,
        attempt,
        err: `${err}`,
      });
      await sleep(wait.intervalMs);
    }
  }
  throw new Error(`ssh did not become ready: ${lastErr ?? "unknown error"}`);
}

async function waitForHostStatus({
  host_id,
  allowed,
  wait,
}: {
  host_id: string;
  allowed: string[];
  wait: WaitOptions;
}): Promise<void> {
  let lastStatus = "unknown";
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    const { rows } = await getPool().query<{ status: string | null }>(
      "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
      [host_id],
    );
    const status = String(rows[0]?.status ?? "unknown");
    lastStatus = status;
    if (allowed.includes(status)) {
      return;
    }
    if (status === "error") {
      throw new Error("host status became error");
    }
    await sleep(wait.intervalMs);
  }
  throw new Error(
    `timeout waiting for host status (${allowed.join(", ")}); last status=${lastStatus}`,
  );
}

async function waitForBackupIndexed({
  account_id,
  project_id,
  wait,
}: {
  account_id: string;
  project_id: string;
  wait: WaitOptions;
}): Promise<{ id: string }> {
  let lastCount = 0;
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    const backups = (await getBackups({
      account_id,
      project_id,
      indexed_only: true,
    })) as any[];
    lastCount = backups.length;
    if (backups.length > 0 && backups[0]?.id) {
      const sorted = [...backups].sort((a, b) =>
        String(b?.time ?? "").localeCompare(String(a?.time ?? "")),
      );
      return { id: sorted[0].id };
    }
    await sleep(wait.intervalMs);
  }
  throw new Error(`backup index never appeared (indexed backups=${lastCount})`);
}

async function waitForLroDone({
  op_id,
  wait,
}: {
  op_id: string;
  wait: WaitOptions;
}): Promise<{ status: string; error?: string | null }> {
  let lastStatus = "unknown";
  let lastError: string | null | undefined;
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    const { rows } = await getPool().query<{
      status: string | null;
      error: string | null;
    }>("SELECT status, error FROM long_running_operations WHERE op_id=$1", [
      op_id,
    ]);
    const row = rows[0];
    const status = String(row?.status ?? "unknown");
    lastStatus = status;
    lastError = row?.error;
    if (["succeeded", "failed", "canceled", "expired"].includes(status)) {
      return { status, error: row?.error };
    }
    await sleep(wait.intervalMs);
  }
  throw new Error(
    `timeout waiting for lro ${op_id}; last status=${lastStatus} error=${lastError ?? ""}`,
  );
}

async function waitForProjectPlacement({
  project_id,
  host_id,
  wait,
}: {
  project_id: string;
  host_id: string;
  wait: WaitOptions;
}): Promise<void> {
  let lastHost = "unknown";
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    const { rows } = await getPool().query<{ host_id: string | null }>(
      "SELECT host_id FROM projects WHERE project_id=$1",
      [project_id],
    );
    const current = String(rows[0]?.host_id ?? "");
    lastHost = current || "none";
    if (current === host_id) return;
    await sleep(wait.intervalMs);
  }
  throw new Error(
    `project placement did not update to destination host; last host_id=${lastHost}`,
  );
}

async function waitForProjectFileValue({
  project_id,
  path,
  expected,
  wait,
}: {
  project_id: string;
  path: string;
  expected: string;
  wait: WaitOptions;
}): Promise<void> {
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    try {
      const client = fsClient({
        client: conatWithProjectRouting(),
        subject: fsSubject({ project_id }),
      });
      const value = await client.readFile(path, "utf8");
      if (value === expected) return;
    } catch (err) {
      logger.debug("self-host smoke readFile retry", {
        project_id,
        path,
        attempt,
        err: `${err}`,
      });
    }
    await sleep(wait.intervalMs);
  }
  throw new Error(`timeout waiting for restored file '${path}'`);
}

async function launchMultipassVm({
  vmName,
  vmImage,
  vmUser,
  vmCpus,
  vmMemoryGb,
  vmDiskGb,
  sshPublicKey,
  tempRoot,
  tempDirs,
}: {
  vmName: string;
  vmImage: string;
  vmUser: string;
  vmCpus: number;
  vmMemoryGb: number;
  vmDiskGb: number;
  sshPublicKey: string;
  tempRoot: string;
  tempDirs: string[];
}): Promise<{ vmIp: string; sshTarget: string }> {
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "cocalc-self-host-smoke-"));
  tempDirs.push(tempDir);
  const cloudInitPath = join(tempDir, "cloud-init.yaml");
  const cloudInit = `#cloud-config
users:
  - name: ${vmUser}
    ssh_authorized_keys:
      - ${quoteYamlSingle(sshPublicKey)}
`;
  await writeFile(cloudInitPath, cloudInit, "utf8");
  const args = [
    "launch",
    vmImage,
    "--name",
    vmName,
    "--cpus",
    String(vmCpus),
    "--memory",
    `${vmMemoryGb}G`,
    "--disk",
    `${vmDiskGb}G`,
    "--cloud-init",
    cloudInitPath,
  ];
  await runCommand("multipass", args, { timeoutMs: 8 * 60 * 1000 });
  const vmIp = await getMultipassIp(vmName);
  return { vmIp, sshTarget: `${vmUser}@${vmIp}` };
}

async function cleanupMultipassVm(vmName: string): Promise<void> {
  try {
    await runCommand("multipass", ["delete", vmName], { timeoutMs: 120_000 });
  } catch (err) {
    logger.warn("self-host smoke multipass delete failed", {
      vm_name: vmName,
      err: `${err}`,
    });
  }
  try {
    await runCommand("multipass", ["purge"], { timeoutMs: 120_000 });
  } catch (err) {
    logger.warn("self-host smoke multipass purge failed", {
      vm_name: vmName,
      err: `${err}`,
    });
  }
}

async function listMultipassVmNames(): Promise<string[]> {
  try {
    const { stdout } = await runCommand("multipass", ["list", "--format", "json"]);
    const parsed = JSON.parse(stdout);
    const list = Array.isArray(parsed?.list) ? parsed.list : [];
    return list
      .map((x: any) => `${x?.name ?? ""}`.trim())
      .filter((name: string) => !!name);
  } catch {
    const { stdout } = await runCommand("multipass", ["list"]);
    const lines = stdout.split("\n").map((s) => s.trim());
    const names: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith("Name")) continue;
      const name = line.split(/\s+/)[0];
      if (name) names.push(name);
    }
    return names;
  }
}

async function cleanupExistingSmokeVms(): Promise<void> {
  const all = await listMultipassVmNames();
  const smokeVms = all.filter((name) => name.startsWith("cocalc-smoke-"));
  if (!smokeVms.length) return;
  logger.info("self-host smoke cleanup existing multipass VMs", {
    count: smokeVms.length,
    names: smokeVms,
  });
  for (const name of smokeVms) {
    await cleanupMultipassVm(name);
  }
}

export async function runSelfHostMultipassBackupSmoke(
  opts: SelfHostMultipassSmokeOptions = {},
): Promise<SelfHostMultipassSmokeResult> {
  const steps: StepResult[] = [];
  const emit =
    opts.log ??
    ((event: LogEvent) => {
      logger.info("self-host smoke", event);
    });
  const account_id = await resolveSmokeAccountId(opts.account_id);
  const vmName = opts.vm_name ?? `cocalc-smoke-${Date.now().toString(36)}`;
  const vmImage = opts.vm_image ?? "24.04";
  const vmUser = opts.vm_user ?? "ubuntu";
  const vmCpus = opts.vm_cpus ?? 2;
  const vmMemoryGb = opts.vm_memory_gb ?? 8;
  const vmDiskGb = opts.vm_disk_gb ?? 40;
  const cleanupOnSuccess = opts.cleanup_on_success ?? true;
  const cleanupOnFailure = opts.cleanup_on_failure ?? false;
  const verifyDeprovision = opts.verify_deprovision ?? true;
  const verifyBackupIndexContents = opts.verify_backup_index_contents ?? true;
  const verifyMoveRestoreOnSecondHost =
    opts.verify_move_restore_on_second_host ?? true;
  const secondVmName = verifyMoveRestoreOnSecondHost
    ? `${vmName}-dest`
    : undefined;
  const waitSshReady = resolveWait(opts.wait?.ssh_ready, DEFAULT_SSH_READY_WAIT);
  const waitHostRunning = resolveWait(
    opts.wait?.host_running,
    DEFAULT_HOST_RUNNING_WAIT,
  );
  const waitBackupIndexed = resolveWait(
    opts.wait?.backup_indexed,
    DEFAULT_BACKUP_INDEXED_WAIT,
  );
  const waitHostDeprovisioned = resolveWait(
    opts.wait?.host_deprovisioned,
    DEFAULT_HOST_DEPROVISIONED_WAIT,
  );
  const waitMoveCompleted = resolveWait(
    opts.wait?.move_completed,
    DEFAULT_MOVE_COMPLETED_WAIT,
  );
  const waitRestoredFile = resolveWait(
    opts.wait?.restored_file,
    DEFAULT_RESTORED_FILE_WAIT,
  );

  const tempDirs: string[] = [];
  const createdVmNames: string[] = [];
  const cleanupHostIds = new Set<string>();
  const smokeTmpBase = join(homedir(), "cocalc-smoke-runner");
  let vmIp: string | undefined;
  let sshTarget: string | undefined;
  let secondVmIp: string | undefined;
  let secondSshTarget: string | undefined;
  let host_id: string | undefined;
  let second_host_id: string | undefined;
  let project_id: string | undefined;
  let backup_id: string | undefined;
  let backup_op_id: string | undefined;
  let move_op_id: string | undefined;
  let restore_op_id: string | undefined;
  const sentinelPath = "smoke-self-host-backup/self-host-backup.txt";
  const sentinelValue = `self-host-smoke:${Date.now()}:${randomUUID()}`;
  const debug_hints = {
    host_log: "/mnt/cocalc/data/log",
    project_host_log: "/home/cocalc-host/cocalc-host/bootstrap/bootstrap.log",
    backup_log: "/mnt/cocalc/data/log",
  };

  const runStep = async (name: string, fn: () => Promise<void>) => {
    const startedAt = new Date();
    emit({ step: name, status: "start" });
    try {
      await fn();
      const finishedAt = new Date();
      steps.push({
        name,
        status: "ok",
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
      });
      emit({ step: name, status: "ok" });
    } catch (err) {
      const finishedAt = new Date();
      const message = err instanceof Error ? err.message : String(err);
      steps.push({
        name,
        status: "failed",
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        error: message,
      });
      emit({ step: name, status: "failed", message });
      throw err;
    }
  };

  const cleanup = async () => {
    if (project_id) {
      try {
        await deleteProject({ project_id, skipPermissionCheck: true });
      } catch (err) {
        logger.warn("self-host smoke cleanup project failed", {
          project_id,
          err: `${err}`,
        });
      }
    }
    for (const cleanupHostId of cleanupHostIds) {
      try {
        await deleteHostInternal({ account_id, id: cleanupHostId });
      } catch (err) {
        logger.warn("self-host smoke cleanup host failed", {
          host_id: cleanupHostId,
          err: `${err}`,
        });
      }
    }
    for (const name of createdVmNames) {
      await cleanupMultipassVm(name);
    }
  };

  try {
    let sshPublicKey = "";
    await runStep("preflight", async () => {
      await requireCommand("multipass");
      await requireCommand("ssh");
      await cleanupExistingSmokeVms();
      sshPublicKey = await resolveSshPublicKey(opts.ssh_public_key_path);
    });

    await runStep("launch_multipass_vm", async () => {
      const launched = await launchMultipassVm({
        vmName,
        vmImage,
        vmUser,
        vmCpus,
        vmMemoryGb,
        vmDiskGb,
        sshPublicKey,
        tempRoot: smokeTmpBase,
        tempDirs,
      });
      vmIp = launched.vmIp;
      sshTarget = launched.sshTarget;
      createdVmNames.push(vmName);
    });

    await runStep("wait_ssh_ready", async () => {
      if (!sshTarget) throw new Error("missing ssh target");
      await waitForSshReady({ sshTarget, wait: waitSshReady });
    });

    await runStep("create_self_host_record", async () => {
      if (!sshTarget) throw new Error("missing ssh target");
      const host = await createHost({
        account_id,
        name: `Self-host smoke ${vmName}`,
        region: "pending",
        size: "custom",
        gpu: false,
        machine: {
          cloud: "self-host",
          storage_mode: "persistent",
          disk_gb: vmDiskGb,
          metadata: {
            cpu: vmCpus,
            ram_gb: vmMemoryGb,
            self_host_mode: "local",
            self_host_kind: "direct",
            self_host_ssh_target: sshTarget,
          },
        },
      });
      host_id = host.id;
      cleanupHostIds.add(host.id);
    });

    await runStep("start_host", async () => {
      if (!host_id) throw new Error("missing host_id");
      await startHostInternal({ account_id, id: host_id });
      await waitForHostStatus({
        host_id,
        allowed: ["running", "active"],
        wait: waitHostRunning,
      });
    });

    await runStep("create_project", async () => {
      if (!host_id) throw new Error("missing host_id");
      project_id = await createProject({
        account_id,
        title: `self-host backup smoke ${vmName}`,
        host_id,
        start: false,
      });
    });

    await runStep("start_project", async () => {
      if (!project_id) throw new Error("missing project_id");
      await startProject({ account_id, project_id, wait: true });
    });

    await runStep("write_sentinel_file", async () => {
      if (!project_id) throw new Error("missing project_id");
      const client = fsClient({
        client: conatWithProjectRouting(),
        subject: fsSubject({ project_id }),
      });
      await client.mkdir(dirname(sentinelPath), { recursive: true });
      await client.writeFile(sentinelPath, sentinelValue);
    });

    await runStep("create_backup", async () => {
      if (!project_id) throw new Error("missing project_id");
      const op = await createProjectBackup({ account_id, project_id });
      backup_op_id = op.op_id;
    });

    await runStep("wait_backup_indexed", async () => {
      if (!project_id) throw new Error("missing project_id");
      const backup = await waitForBackupIndexed({
        account_id,
        project_id,
        wait: waitBackupIndexed,
      });
      backup_id = backup.id;
    });

    if (verifyBackupIndexContents) {
      await runStep("verify_backup_index_contents", async () => {
        if (!project_id || !backup_id) {
          throw new Error("missing backup context");
        }
        const listing = (await getBackupFiles({
          account_id,
          project_id,
          id: backup_id,
          path: dirname(sentinelPath),
        })) as any;
        const children = Array.isArray(listing)
          ? listing
          : Array.isArray(listing?.children)
            ? listing.children
            : [];
        const found = children.some((entry: any) =>
          String(entry?.name ?? "").includes("self-host-backup.txt"),
        );
        if (!found) {
          throw new Error("backup index did not include sentinel file");
        }
      });
    }

    if (verifyMoveRestoreOnSecondHost) {
      await runStep("launch_second_multipass_vm", async () => {
        if (!secondVmName) throw new Error("missing second vm name");
        const launched = await launchMultipassVm({
          vmName: secondVmName,
          vmImage,
          vmUser,
          vmCpus,
          vmMemoryGb,
          vmDiskGb,
          sshPublicKey,
          tempRoot: smokeTmpBase,
          tempDirs,
        });
        secondVmIp = launched.vmIp;
        secondSshTarget = launched.sshTarget;
        createdVmNames.push(secondVmName);
      });

      await runStep("wait_second_ssh_ready", async () => {
        if (!secondSshTarget) throw new Error("missing second ssh target");
        await waitForSshReady({ sshTarget: secondSshTarget, wait: waitSshReady });
      });

      await runStep("create_second_self_host_record", async () => {
        if (!secondSshTarget || !secondVmName) {
          throw new Error("missing second host context");
        }
        const host = await createHost({
          account_id,
          name: `Self-host smoke ${secondVmName}`,
          region: "pending",
          size: "custom",
          gpu: false,
          machine: {
            cloud: "self-host",
            storage_mode: "persistent",
            disk_gb: vmDiskGb,
            metadata: {
              cpu: vmCpus,
              ram_gb: vmMemoryGb,
              self_host_mode: "local",
              self_host_kind: "direct",
              self_host_ssh_target: secondSshTarget,
            },
          },
        });
        second_host_id = host.id;
        cleanupHostIds.add(host.id);
      });

      await runStep("start_second_host", async () => {
        if (!second_host_id) throw new Error("missing second_host_id");
        await startHostInternal({ account_id, id: second_host_id });
        await waitForHostStatus({
          host_id: second_host_id,
          allowed: ["running", "active"],
          wait: waitHostRunning,
        });
      });

      await runStep("move_project_to_second_host", async () => {
        if (!project_id || !second_host_id) {
          throw new Error("missing move context");
        }
        const op = await moveProject({
          account_id,
          project_id,
          dest_host_id: second_host_id,
        });
        move_op_id = op.op_id;
        const summary = await waitForLroDone({
          op_id: op.op_id,
          wait: waitMoveCompleted,
        });
        if (summary.status !== "succeeded") {
          throw new Error(
            `move lro did not succeed: status=${summary.status} error=${summary.error ?? ""}`,
          );
        }
        await waitForProjectPlacement({
          project_id,
          host_id: second_host_id,
          wait: waitMoveCompleted,
        });
      });

      await runStep("restore_backup_on_second_host", async () => {
        if (!project_id || !backup_id) {
          throw new Error("missing restore context");
        }
        const op = await restoreProjectBackup({
          account_id,
          project_id,
          id: backup_id,
        });
        restore_op_id = op.op_id;
        const summary = await waitForLroDone({
          op_id: op.op_id,
          wait: waitMoveCompleted,
        });
        if (summary.status !== "succeeded") {
          throw new Error(
            `restore lro did not succeed: status=${summary.status} error=${summary.error ?? ""}`,
          );
        }
      });

      await runStep("verify_restored_file_on_second_host", async () => {
        if (!project_id) throw new Error("missing project_id");
        await waitForProjectFileValue({
          project_id,
          path: sentinelPath,
          expected: sentinelValue,
          wait: waitRestoredFile,
        });
      });
    }

    if (verifyDeprovision) {
      await runStep("deprovision_hosts", async () => {
        const hostIds = [second_host_id, host_id].filter(Boolean) as string[];
        for (const id of hostIds) {
          await deleteHost({ account_id, id, skip_backups: true });
          await waitForHostStatus({
            host_id: id,
            allowed: ["deprovisioned"],
            wait: waitHostDeprovisioned,
          });
          cleanupHostIds.delete(id);
        }
      });
    }

    if (cleanupOnSuccess) {
      await runStep("cleanup", async () => {
        await cleanup();
      });
    }

    return {
      ok: true,
      account_id,
      vm_name: vmName,
      vm_ip: vmIp,
      ssh_target: sshTarget,
      host_id,
      second_vm_name: secondVmName,
      second_vm_ip: secondVmIp,
      second_ssh_target: secondSshTarget,
      second_host_id,
      project_id,
      backup_id,
      backup_op_id,
      move_op_id,
      restore_op_id,
      sentinel_path: sentinelPath,
      sentinel_value: sentinelValue,
      steps,
      debug_hints,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cleanupOnFailure) {
      await cleanup();
    }
    return {
      ok: false,
      account_id,
      vm_name: vmName,
      vm_ip: vmIp,
      ssh_target: sshTarget,
      host_id,
      second_vm_name: secondVmName,
      second_vm_ip: secondVmIp,
      second_ssh_target: secondSshTarget,
      second_host_id,
      project_id,
      backup_id,
      backup_op_id,
      move_op_id,
      restore_op_id,
      sentinel_path: sentinelPath,
      sentinel_value: sentinelValue,
      steps,
      error: message,
      debug_hints,
    };
  } finally {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
