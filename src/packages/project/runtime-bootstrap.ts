/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_PROJECT_RUNTIME_GID,
  DEFAULT_PROJECT_RUNTIME_HOME,
  DEFAULT_PROJECT_RUNTIME_UID,
  DEFAULT_PROJECT_RUNTIME_USER,
} from "@cocalc/util/project-runtime";
import { getLogger } from "./logger";

const logger = getLogger("runtime-bootstrap");

type RuntimeIdentity = {
  user: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
};

type MissingRuntimePackages = {
  sudo: boolean;
  caCertificates: boolean;
};

const DISABLED_RUNTIME_PASSWORD_HASH =
  "$6$cocalcruntime$2xieJC95lcJzQ05t39hXoMmKKs4hYtiKuOTfoHqbIaFG2rb8JC7M0bPdSej2EFWrhnuKZbqijNAoOZKnqZepp1";

function parseRuntimeIdentity(): RuntimeIdentity {
  const user =
    `${process.env.COCALC_RUNTIME_USER ?? DEFAULT_PROJECT_RUNTIME_USER}`.trim() ||
    DEFAULT_PROJECT_RUNTIME_USER;
  const uid = Number.parseInt(
    `${process.env.COCALC_RUNTIME_UID ?? DEFAULT_PROJECT_RUNTIME_UID}`,
    10,
  );
  const gid = Number.parseInt(
    `${process.env.COCALC_RUNTIME_GID ?? DEFAULT_PROJECT_RUNTIME_GID}`,
    10,
  );
  const home =
    `${process.env.COCALC_RUNTIME_HOME ?? DEFAULT_PROJECT_RUNTIME_HOME}`.trim() ||
    DEFAULT_PROJECT_RUNTIME_HOME;
  const shell = `${process.env.SHELL ?? ""}`.trim() || "/bin/bash";
  return {
    user,
    uid: Number.isFinite(uid) ? uid : DEFAULT_PROJECT_RUNTIME_UID,
    gid: Number.isFinite(gid) ? gid : DEFAULT_PROJECT_RUNTIME_GID,
    home,
    shell,
  };
}

function shouldBootstrapRuntimeUser(): boolean {
  const enabled = `${process.env.COCALC_RUNTIME_BOOTSTRAP ?? ""}`
    .trim()
    .toLowerCase();
  if (!["1", "true", "yes", "on"].includes(enabled)) {
    return false;
  }
  if (typeof process.getuid !== "function") {
    return false;
  }
  return process.getuid() === 0;
}

export function rewritePasswd(
  current: string,
  runtime: RuntimeIdentity,
): string {
  const lines = current
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const fields = line.split(":");
      return !(fields[0] === runtime.user || fields[2] === `${runtime.uid}`);
    });
  lines.push(
    `${runtime.user}:x:${runtime.uid}:${runtime.gid}:CoCalc User:${runtime.home}:${runtime.shell}`,
  );
  return `${lines.join("\n")}\n`;
}

export function rewriteGroup(
  current: string,
  runtime: RuntimeIdentity,
): string {
  const lines = current
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const fields = line.split(":");
      return !(fields[0] === runtime.user || fields[2] === `${runtime.gid}`);
    });
  lines.push(`${runtime.user}:x:${runtime.gid}:`);
  return `${lines.join("\n")}\n`;
}

export function rewriteShadow(
  current: string,
  runtime: RuntimeIdentity,
): string {
  const lines = current
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => line.split(":")[0] !== runtime.user);
  lines.push(
    `${runtime.user}:${DISABLED_RUNTIME_PASSWORD_HASH}:20000:0:99999:7:::`,
  );
  return `${lines.join("\n")}\n`;
}

async function rewriteIfChanged(
  path: string,
  rewrite: (current: string) => string,
  mode?: number,
): Promise<void> {
  const current = await readFile(path, "utf8").catch((err) => {
    const message = `${err}`;
    if (
      message.includes("ENOENT") ||
      message.includes("no such file") ||
      message.includes("No such file")
    ) {
      return "";
    }
    throw err;
  });
  const next = rewrite(current);
  if (next === current) {
    return;
  }
  await writeFile(path, next, mode == null ? undefined : { mode });
}

async function commandExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(
  candidates: string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await commandExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function hasCaCertificates(): Promise<boolean> {
  for (const path of [
    "/etc/ssl/certs",
    "/etc/ssl/cert.pem",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    "/etc/ssl/ca-bundle.pem",
  ]) {
    if (await pathExists(path)) {
      return true;
    }
  }
  return false;
}

async function runCommand(command: string, args: string[]): Promise<void> {
  logger.info("runtime bootstrap command", { command, args });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        DEBIAN_FRONTEND: process.env.DEBIAN_FRONTEND ?? "noninteractive",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16000) {
        stderr += `${chunk}`;
      }
    });
    child.stdout.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code}: ${stderr.trim()}`,
        ),
      );
    });
  });
}

async function detectMissingRuntimePackages(): Promise<MissingRuntimePackages> {
  return {
    sudo: (await findExecutable(["/usr/bin/sudo", "/bin/sudo"])) == null,
    caCertificates: !(await hasCaCertificates()),
  };
}

async function installMissingRuntimePackages(): Promise<void> {
  const missing = await detectMissingRuntimePackages();
  const packages: string[] = [];
  if (missing.sudo) {
    packages.push("sudo");
  }
  if (missing.caCertificates) {
    packages.push("ca-certificates");
  }
  if (!packages.length) {
    return;
  }

  const aptGet = await findExecutable(["/usr/bin/apt-get", "/bin/apt-get"]);
  if (aptGet) {
    await runCommand(aptGet, ["update"]);
    await runCommand(aptGet, [
      "install",
      "-y",
      "--no-install-recommends",
      ...packages,
    ]);
    await rm("/var/lib/apt/lists", { recursive: true, force: true }).catch(
      () => {},
    );
    await mkdir("/var/lib/apt/lists/partial", { recursive: true }).catch(
      () => {},
    );
  } else {
    const dnf = await findExecutable(["/usr/bin/dnf", "/bin/dnf"]);
    const microdnf = await findExecutable([
      "/usr/bin/microdnf",
      "/bin/microdnf",
    ]);
    const yum = await findExecutable(["/usr/bin/yum", "/bin/yum"]);
    const zypper = await findExecutable(["/usr/bin/zypper", "/bin/zypper"]);
    if (dnf) {
      await runCommand(dnf, ["install", "-y", ...packages]);
      await runCommand(dnf, ["clean", "all"]).catch(() => {});
    } else if (microdnf) {
      await runCommand(microdnf, ["install", "-y", ...packages]);
      await runCommand(microdnf, ["clean", "all"]).catch(() => {});
    } else if (yum) {
      await runCommand(yum, ["install", "-y", ...packages]);
      await runCommand(yum, ["clean", "all"]).catch(() => {});
    } else if (zypper) {
      await runCommand(zypper, [
        "--non-interactive",
        "--gpg-auto-import-keys",
        "refresh",
      ]).catch(() => {});
      await runCommand(zypper, [
        "--non-interactive",
        "install",
        "--no-recommends",
        ...packages,
      ]);
      await runCommand(zypper, ["clean", "--all"]).catch(() => {});
    } else {
      throw new Error(
        `runtime bootstrap cannot install missing packages (${packages.join(", ")}): no supported package manager found`,
      );
    }
  }

  const updateCaCertificates = await findExecutable([
    "/usr/sbin/update-ca-certificates",
    "/usr/bin/update-ca-certificates",
    "/sbin/update-ca-certificates",
    "/bin/update-ca-certificates",
  ]);
  if (updateCaCertificates) {
    await runCommand(updateCaCertificates, []).catch(() => {});
  }
  const updateCaTrust = await findExecutable([
    "/usr/bin/update-ca-trust",
    "/usr/sbin/update-ca-trust",
    "/bin/update-ca-trust",
    "/sbin/update-ca-trust",
  ]);
  if (updateCaTrust) {
    await runCommand(updateCaTrust, []).catch(() => {});
  }

  const remaining = await detectMissingRuntimePackages();
  if (remaining.sudo || remaining.caCertificates) {
    throw new Error(
      `runtime bootstrap failed to provision required packages: sudo missing=${remaining.sudo}, ca-certificates missing=${remaining.caCertificates}`,
    );
  }
}

async function resolveRuntimeShell(preferred: string): Promise<string> {
  if (await commandExists(preferred)) {
    return preferred;
  }
  if (preferred !== "/bin/sh" && (await commandExists("/bin/sh"))) {
    return "/bin/sh";
  }
  return preferred;
}

async function configureSudo(runtime: RuntimeIdentity): Promise<void> {
  if (
    !(await commandExists("/usr/bin/sudo")) &&
    !(await commandExists("/bin/sudo"))
  ) {
    return;
  }
  const sudoersDir = "/etc/sudoers.d";
  const sudoersPath = `${sudoersDir}/cocalc-project-runtime`;
  const content = `${runtime.user} ALL=(ALL) NOPASSWD:ALL\n`;
  try {
    const current = await readFile(sudoersPath, "utf8").catch(() => null);
    if (current === content) {
      return;
    }
    await mkdir(sudoersDir, { recursive: true });
    await writeFile(sudoersPath, content, { mode: 0o440 });
    await chmod(sudoersPath, 0o440);
  } catch (err) {
    logger.warn("unable to configure sudo during runtime bootstrap", {
      user: runtime.user,
      path: sudoersPath,
      err: `${err}`,
    });
  }
}

async function ensureRuntimeFiles(runtime: RuntimeIdentity): Promise<void> {
  await rewriteIfChanged("/etc/group", (current) =>
    rewriteGroup(current, runtime),
  );
  await rewriteIfChanged("/etc/passwd", (current) =>
    rewritePasswd(current, runtime),
  );
  await rewriteIfChanged(
    "/etc/shadow",
    (current) => rewriteShadow(current, runtime),
    0o600,
  );
  await mkdir(runtime.home, { recursive: true });
  await mkdir(dirname(runtime.home), { recursive: true });
  await configureSudo(runtime);
}

export async function maybeActivateRuntimeUser(): Promise<void> {
  if (!shouldBootstrapRuntimeUser()) {
    return;
  }
  const runtime = parseRuntimeIdentity();
  runtime.shell = await resolveRuntimeShell(runtime.shell);
  logger.info("activating runtime user", {
    user: runtime.user,
    uid: runtime.uid,
    gid: runtime.gid,
    home: runtime.home,
  });
  await installMissingRuntimePackages();
  await ensureRuntimeFiles(runtime);
  process.env.HOME = runtime.home;
  process.env.USER = runtime.user;
  process.env.LOGNAME = runtime.user;
  process.env.COCALC_USERNAME = runtime.user;
  process.env.SHELL = runtime.shell;
  process.chdir(runtime.home);
  if (typeof process.setgroups === "function") {
    process.setgroups([runtime.gid]);
  }
  if (
    typeof process.setgid !== "function" ||
    typeof process.setuid !== "function"
  ) {
    throw new Error("runtime user activation requires setuid/setgid support");
  }
  process.setgid(runtime.gid);
  process.setuid(runtime.uid);
  logger.info("runtime user activated", {
    user: process.env.USER,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    home: process.env.HOME,
  });
}
