/**
 * System command execution helpers.
 *
 * This module centralizes process spawning, command existence checks, and ssh/
 * cloudflared utility probes used by host and project command handlers.
 */
import { spawn, spawnSync } from "node:child_process";
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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
  } = {},
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio ?? "inherit",
      env: options.env ?? process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export function commandExists(command: string): boolean {
  const probe = spawnSync(
    "bash",
    ["-lc", `command -v ${JSON.stringify(command)}`],
    {
      stdio: "ignore",
    },
  );
  return probe.status === 0;
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
  return undefined;
}

export function cocalcCliDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = `${env.COCALC_CLI_DATA_DIR ?? ""}`.trim();
  if (explicit) {
    return explicit;
  }
  const xdgData = `${env.XDG_DATA_HOME ?? ""}`.trim();
  return join(xdgData || join(homedir(), ".local", "share"), "cocalc");
}

export function localCloudflaredBinaryPath(
  dataDir = cocalcCliDataDir(),
): string {
  return join(dataDir, "bin", "cloudflared");
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function resolveCloudflaredBinary(): string {
  const configured = `${process.env.COCALC_CLI_CLOUDFLARED ?? ""}`.trim();
  if (configured) {
    if (!commandExists(configured)) {
      throw new Error(
        `COCALC_CLI_CLOUDFLARED is set but not executable: ${configured}`,
      );
    }
    return configured;
  }
  if (commandExists("cloudflared")) {
    return "cloudflared";
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
  const destination = localCloudflaredBinaryPath();
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
      await chmod(tempPath, 0o755);
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
    await chmod(destination, 0o755);
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
        child.kill("SIGKILL");
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
