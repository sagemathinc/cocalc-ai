/**
 * System command execution helpers.
 *
 * This module centralizes process spawning, command existence checks, and ssh/
 * cloudflared utility probes used by host and project command handlers.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";

import { cocalcCliDataDir as nativeCliDataDir } from "../../core/platform-paths";

function terminateChild(child: ReturnType<typeof spawn>, force = false): void {
  if (process.platform === "win32") {
    child.kill();
    return;
  }
  child.kill(force ? "SIGKILL" : "SIGTERM");
}

export async function runSsh(args: string[]): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    stdio?: "inherit" | "pipe";
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<number> {
  return await new Promise((resolve, reject) => {
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    const child = spawn(command, args, {
      stdio: options.stdio ?? "inherit",
      env: options.env ?? process.env,
    });
    const timeoutMs = options.timeoutMs;
    if (timeoutMs != null && timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateChild(child);
        killTimeout = setTimeout(() => terminateChild(child, true), 5000);
      }, timeoutMs);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolve(timedOut ? 124 : (code ?? 1));
    });
  });
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function commandPathCandidates(
  command: string,
  {
    env = process.env,
    platform = process.platform,
  }: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): string[] {
  const value = command.trim();
  if (!value) return [];
  const pathImpl = platform === "win32" ? win32 : { isAbsolute, join };
  const hasDirectory =
    pathImpl.isAbsolute(value) || value.includes("/") || value.includes("\\");
  const extensions =
    platform === "win32" && !win32.extname(value)
      ? (`${env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD"}`
          .split(";")
          .map((ext) => ext.trim())
          .filter(Boolean) as string[])
      : [""];
  const directories = hasDirectory
    ? [""]
    : `${env.PATH ?? ""}`
        .split(platform === "win32" ? ";" : ":")
        .map((entry) => entry.trim())
        .filter(Boolean);
  const candidates: string[] = [];
  for (const directory of directories) {
    for (const extension of extensions) {
      const name = `${value}${extension}`;
      const candidate = directory ? pathImpl.join(directory, name) : name;
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function resolveCommandPath(
  command: string,
  input?: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  },
): string | undefined {
  const platform = input?.platform ?? process.platform;
  return commandPathCandidates(command, input).find((candidate) =>
    isExecutableFile(candidate, platform),
  );
}

export function commandExists(command: string): boolean {
  return resolveCommandPath(command) != null;
}

function cloudflaredInstallHint(): string {
  const platform = process.platform;
  if (platform === "darwin") {
    return "brew install cloudflared";
  }
  if (platform === "linux") {
    return "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/";
  }
  return "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/";
}

const CLOUDFLARED_DOWNLOAD_BASE =
  "https://github.com/cloudflare/cloudflared/releases/latest/download";

export type CloudflaredDownloadSpec = {
  filename: string;
  kind: "binary" | "tgz";
  url: string;
};

export function getCloudflaredDownloadSpec(opts?: {
  platform?: NodeJS.Platform;
  arch?: string;
}): CloudflaredDownloadSpec | undefined {
  const platform = opts?.platform ?? process.platform;
  const arch = opts?.arch ?? process.arch;
  if (platform === "linux") {
    if (arch === "x64") {
      return {
        filename: "cloudflared-linux-amd64",
        kind: "binary",
        url: `${CLOUDFLARED_DOWNLOAD_BASE}/cloudflared-linux-amd64`,
      };
    }
    if (arch === "arm64") {
      return {
        filename: "cloudflared-linux-arm64",
        kind: "binary",
        url: `${CLOUDFLARED_DOWNLOAD_BASE}/cloudflared-linux-arm64`,
      };
    }
    return undefined;
  }
  if (platform === "darwin") {
    if (arch === "x64") {
      return {
        filename: "cloudflared-darwin-amd64.tgz",
        kind: "tgz",
        url: `${CLOUDFLARED_DOWNLOAD_BASE}/cloudflared-darwin-amd64.tgz`,
      };
    }
    if (arch === "arm64") {
      return {
        filename: "cloudflared-darwin-arm64.tgz",
        kind: "tgz",
        url: `${CLOUDFLARED_DOWNLOAD_BASE}/cloudflared-darwin-arm64.tgz`,
      };
    }
  }
  if (platform === "win32" && arch === "x64") {
    return {
      filename: "cloudflared-windows-amd64.exe",
      kind: "binary",
      url: `${CLOUDFLARED_DOWNLOAD_BASE}/cloudflared-windows-amd64.exe`,
    };
  }
  return undefined;
}

export function cocalcCliDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return nativeCliDataDir({ env });
}

export function localCloudflaredBinaryPath(
  dataDir = cocalcCliDataDir(),
): string {
  return join(
    dataDir,
    "bin",
    process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
  );
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return (
      info.isFile() &&
      (process.platform === "win32" || (info.mode & 0o111) !== 0)
    );
  } catch {
    return false;
  }
}

export function resolveCloudflaredBinary(): string {
  const configured = `${process.env.COCALC_CLI_CLOUDFLARED ?? ""}`.trim();
  if (configured) {
    const path = resolveCommandPath(configured);
    if (!path) {
      throw new Error(
        `COCALC_CLI_CLOUDFLARED is set but not executable: ${configured}`,
      );
    }
    return resolve(path);
  }
  const path = resolveCommandPath("cloudflared");
  if (path) {
    return resolve(path);
  }
  throw new Error(
    `cloudflared is required for project ssh via the Cloudflare ssh hostname; install it (${cloudflaredInstallHint()}) or use --direct`,
  );
}

export async function ensureCloudflaredBinary(): Promise<string> {
  const configured = `${process.env.COCALC_CLI_CLOUDFLARED ?? ""}`.trim();
  if (configured || commandExists("cloudflared")) {
    return resolveCloudflaredBinary();
  }
  const destination = resolve(localCloudflaredBinaryPath());
  if (await isExecutable(destination)) {
    return destination;
  }
  const spec = getCloudflaredDownloadSpec();
  if (!spec) {
    throw new Error(
      `automatic cloudflared install is unsupported on ${process.platform}/${process.arch}; install it manually (${cloudflaredInstallHint()}) or use --direct`,
    );
  }
  const binDir = join(cocalcCliDataDir(), "bin");
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const tempPath = join(
    binDir,
    `${spec.filename}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  try {
    const response = await fetch(spec.url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(
        `download failed with ${response.status} ${response.statusText}`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(tempPath, buffer, { mode: 0o755 });
    if (spec.kind === "binary") {
      if (process.platform !== "win32") await chmod(tempPath, 0o755);
      await rename(tempPath, destination);
    } else {
      const extractDir = await mkdtemp(join(tmpdir(), "cocalc-cloudflared-"));
      try {
        const result = spawnSync("tar", ["-xzf", tempPath, "-C", extractDir], {
          encoding: "utf8",
        });
        if (result.status !== 0) {
          throw new Error(
            `failed to extract cloudflared archive: ${result.stderr || result.stdout || `exit code ${result.status}`}`,
          );
        }
        await rename(join(extractDir, "cloudflared"), destination);
      } finally {
        await rm(extractDir, { recursive: true, force: true });
      }
    }
    if (process.platform !== "win32") await chmod(destination, 0o755);
    return destination;
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

export async function runSshCheck(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stderr: string; timed_out: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("ssh", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let done = false;
    const finish = (result: {
      code: number;
      stderr: string;
      timed_out: boolean;
    }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stderr?.on("data", (chunk) => {
      if (stderr.length >= 8192) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderr += text;
    });

    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("exit", (code) => {
      finish({ code: code ?? 1, stderr, timed_out: false });
    });

    const timer = setTimeout(() => {
      if (done) return;
      try {
        terminateChild(child, true);
      } catch {
        // ignore
      }
      finish({ code: 124, stderr, timed_out: true });
    }, timeoutMs);
  });
}

export function isLikelySshAuthFailure(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes("permission denied") ||
    text.includes("authentication failed") ||
    text.includes("no supported authentication methods") ||
    text.includes("publickey")
  );
}
