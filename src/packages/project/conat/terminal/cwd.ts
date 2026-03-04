import { execFile } from "node:child_process";
import { readlink, realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function supportsTerminalCwdLookup(): boolean {
  return process.platform === "linux" || process.platform === "darwin";
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
    for (const line of `${stdout ?? ""}`.split(/\r?\n/)) {
      if (!line.startsWith("n")) continue;
      const value = line.slice(1).trim();
      if (value.length > 0) return value;
    }
  } catch {
    return;
  }
  return;
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
  return absolute.startsWith(home) ? absolute.slice(home.length + 1) : absolute;
}

