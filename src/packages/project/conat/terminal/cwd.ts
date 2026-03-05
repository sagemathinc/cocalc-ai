import { execFile } from "node:child_process";
import { readlink, realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function supportsTerminalCwdLookup(): boolean {
  return process.platform === "linux" || process.platform === "darwin";
}

export function toHomeRelativePath(
  absolutePath: string,
  homePath: string,
): string {
  return absolutePath.startsWith(homePath)
    ? absolutePath.slice(homePath.length + 1)
    : absolutePath;
}

export function parseDarwinCwdFromLsofOutput(
  stdout: string,
): string | undefined {
  let expectPathForCwd = false;
  for (const line of `${stdout ?? ""}`.split(/\r?\n/)) {
    if (line.startsWith("f")) {
      expectPathForCwd = line === "fcwd";
      continue;
    }
    if (!expectPathForCwd || !line.startsWith("n")) continue;
    const value = line.slice(1);
    return value.length > 0 ? value : undefined;
  }
  return;
}

async function linuxCwd(pid: number): Promise<string | undefined> {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return;
  }
}

async function darwinCwd(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-n", "-P", "-a", "-d", "cwd", "-p", String(pid), "-Fn"],
      {
        timeout: 1500,
        maxBuffer: 256 * 1024,
      },
    );
    return parseDarwinCwdFromLsofOutput(stdout);
  } catch {
    return;
  }
}

export async function terminalCwdForPid(
  pid: number,
  homeInput?: string,
): Promise<string | undefined> {
  if (!supportsTerminalCwdLookup()) return;
  const homeRaw = `${homeInput ?? process.env.HOME ?? ""}`.trim();
  if (!homeRaw) return;
  let home = homeRaw;
  try {
    // Canonicalize HOME so relative conversion is stable even when HOME is a symlink.
    home = await realpath(homeRaw);
  } catch {
    // Keep original HOME when realpath cannot resolve it.
  }
  const absolute =
    process.platform === "linux"
      ? await linuxCwd(pid)
      : process.platform === "darwin"
        ? await darwinCwd(pid)
        : undefined;
  if (!absolute) return;
  return toHomeRelativePath(absolute, home);
}
