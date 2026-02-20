/**
 * System command execution helpers.
 *
 * This module centralizes process spawning, command existence checks, and ssh/
 * cloudflared utility probes used by host and workspace command handlers.
 */
import { spawn, spawnSync } from "node:child_process";

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
  const probe = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(command)}`], {
    stdio: "ignore",
  });
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

export function resolveCloudflaredBinary(): string {
  const configured = `${process.env.COCALC_CLI_CLOUDFLARED ?? ""}`.trim();
  if (configured) {
    if (!commandExists(configured)) {
      throw new Error(`COCALC_CLI_CLOUDFLARED is set but not executable: ${configured}`);
    }
    return configured;
  }
  if (commandExists("cloudflared")) {
    return "cloudflared";
  }
  throw new Error(
    `cloudflared is required for workspace ssh via Cloudflare Access; install it (${cloudflaredInstallHint()}) or use --direct`,
  );
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
    const finish = (result: { code: number; stderr: string; timed_out: boolean }) => {
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
