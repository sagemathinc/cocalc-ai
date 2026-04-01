/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
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

async function rewriteIfChanged(
  path: string,
  rewrite: (current: string) => string,
  mode?: number,
): Promise<void> {
  const current = await readFile(path, "utf8");
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
  await mkdir(sudoersDir, { recursive: true });
  const sudoersPath = `${sudoersDir}/cocalc-project-runtime`;
  const content = `${runtime.user} ALL=(ALL) NOPASSWD:ALL\n`;
  await writeFile(sudoersPath, content, { mode: 0o440 });
  await chmod(sudoersPath, 0o440);
}

async function ensureRuntimeFiles(runtime: RuntimeIdentity): Promise<void> {
  await rewriteIfChanged("/etc/group", (current) =>
    rewriteGroup(current, runtime),
  );
  await rewriteIfChanged("/etc/passwd", (current) =>
    rewritePasswd(current, runtime),
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
