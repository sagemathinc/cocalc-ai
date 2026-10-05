/**
 * Local browser for `cocalc project browser connect`: find Chrome/Chromium,
 * give it a throwaway profile (RAM-backed by default) and DevTools on an
 * OS-chosen loopback port.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, posix, win32 } from "node:path";

export type ProfileStorage = "memory" | "disk";

export interface ProfileDir {
  path: string;
  storage: ProfileStorage;
  // Where the bytes live, for the user: "tmpfs /dev/shm", "RAM disk", ...
  backing: string;
  cleanup: () => Promise<void>;
}

export interface LocalBrowserSystem {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (path: string) => boolean;
  statfsType: (path: string) => number | null;
  run: (command: string, args: string[]) => Promise<string>;
}

const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;
// Chrome's cache is the bulk of a profile; keep a RAM-backed one small.
const DISK_CACHE_BYTES = 64 * 1024 * 1024;
const MAC_RAM_DISK_BYTES = 512 * 1024 * 1024;

export function defaultLocalBrowserSystem(): LocalBrowserSystem {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    exists: existsSync,
    statfsType: (path) => {
      try {
        return statfsSync(path).type;
      } catch {
        return null;
      }
    },
    run: (command, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve(stdout)
            : reject(
                new Error(
                  `${command} ${args.join(" ")} failed (${code}): ${stderr.trim()}`,
                ),
              ),
        );
      }),
  };
}

export function chromeCandidates(
  sys: Pick<LocalBrowserSystem, "platform" | "env" | "home">,
): string[] {
  const { platform, env } = sys;
  if (platform === "darwin") {
    const apps = [
      "Google Chrome",
      "Chromium",
      "Microsoft Edge",
      "Brave Browser",
    ];
    return ["/Applications", posix.join(sys.home, "Applications")].flatMap(
      (dir) =>
        apps.map((app) => posix.join(dir, `${app}.app`, "Contents/MacOS", app)),
    );
  }
  if (platform === "win32") {
    const roots = [
      env.ProgramFiles ?? env.PROGRAMFILES,
      env["ProgramFiles(x86)"] ?? env["PROGRAMFILES(X86)"],
      env.LOCALAPPDATA,
    ].filter((root): root is string => !!root);
    return roots.flatMap((root) => [
      win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);
  }
  const names = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "brave-browser",
  ];
  const dirs = `${env.PATH ?? ""}`.split(delimiter).filter(Boolean);
  return names.flatMap((name) => dirs.map((dir) => posix.join(dir, name)));
}

export function findChrome(
  explicit: string | undefined,
  sys: Pick<LocalBrowserSystem, "platform" | "env" | "home" | "exists">,
): string {
  const chosen = `${explicit ?? sys.env.COCALC_CHROME ?? ""}`.trim();
  if (chosen) {
    if (!sys.exists(chosen)) {
      throw new Error(`browser executable not found: ${chosen}`);
    }
    return chosen;
  }
  const found = chromeCandidates(sys).find((path) => sys.exists(path));
  if (!found) {
    throw new Error(
      "no Chrome, Chromium, Edge or Brave found; pass --chrome <path> or set COCALC_CHROME",
    );
  }
  return found;
}

export function chromeLaunchArgs({
  profileDir,
  url,
  headless,
}: {
  profileDir: string;
  url?: string;
  headless?: boolean;
}): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    // 0: Chrome picks a free loopback port and writes it to DevToolsActivePort.
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    `--disk-cache-size=${DISK_CACHE_BYTES}`,
    ...(headless ? ["--headless=new"] : []),
    url?.trim() || "about:blank",
  ];
}

function removeDir(path: string): Promise<void> {
  // Chrome's helper processes can still be flushing for a moment after the
  // browser process exits.
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
  return Promise.resolve();
}

function tmpfsBase(sys: LocalBrowserSystem): string | null {
  for (const dir of [sys.env.XDG_RUNTIME_DIR, "/dev/shm"]) {
    if (!dir || !sys.exists(dir)) continue;
    const type = sys.statfsType(dir);
    if (type === TMPFS_MAGIC || type === RAMFS_MAGIC) return dir;
  }
  return null;
}

async function macRamDisk(sys: LocalBrowserSystem): Promise<ProfileDir> {
  const sectors = Math.ceil(MAC_RAM_DISK_BYTES / 512);
  const device = (
    await sys.run("hdiutil", ["attach", "-nomount", `ram://${sectors}`])
  ).trim();
  if (!/^\/dev\/disk\d+$/.test(device)) {
    throw new Error(`unexpected hdiutil output: ${device}`);
  }
  const detach = async () => {
    await sys.run("hdiutil", ["detach", device, "-force"]);
  };
  const name = `CoCalcBrowser-${randomBytes(4).toString("hex")}`;
  try {
    await sys.run("diskutil", ["erasevolume", "HFS+", name, device]);
    const volume = `/Volumes/${name}`;
    writeFileSync(`${volume}/.metadata_never_index`, "");
    const path = `${volume}/profile`;
    mkdirSync(path, { mode: 0o700 });
    return { path, storage: "memory", backing: "RAM disk", cleanup: detach };
  } catch (err) {
    await detach().catch(() => {});
    throw err;
  }
}

export async function createProfileDir(
  storage: ProfileStorage,
  sys: LocalBrowserSystem,
): Promise<ProfileDir> {
  if (storage === "disk") {
    const path = mkdtempSync(posix.join(tmpdir(), "cocalc-browser-"));
    return {
      path,
      storage,
      backing: `temporary directory ${tmpdir()}`,
      cleanup: () => removeDir(path),
    };
  }
  if (sys.platform === "darwin") {
    return await macRamDisk(sys);
  }
  const base = sys.platform === "linux" ? tmpfsBase(sys) : null;
  if (!base) {
    throw new Error(
      `no RAM-backed storage found on ${sys.platform}; rerun with --profile-storage disk (a temporary profile, deleted on exit)`,
    );
  }
  const path = mkdtempSync(posix.join(base, "cocalc-browser-"));
  return {
    path,
    storage,
    backing: `tmpfs ${base}`,
    cleanup: () => removeDir(path),
  };
}

export function readDevToolsPort(profileDir: string): number | null {
  try {
    const port = Number(
      readFileSync(`${profileDir}/DevToolsActivePort`, "utf8").split("\n")[0],
    );
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export interface LaunchedBrowser {
  child: ChildProcess;
  port: number;
  exited: Promise<void>;
  stop: () => Promise<void>;
}

export async function launchBrowser({
  executable,
  args,
  profileDir,
  timeoutMs = 30_000,
}: {
  executable: string;
  args: string[];
  profileDir: string;
  timeoutMs?: number;
}): Promise<LaunchedBrowser> {
  // Own process group: Ctrl-C reaches us, and we decide the teardown order.
  const child = spawn(executable, args, {
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
  let hasExited = false;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      hasExited = true;
      resolve();
    });
    child.once("error", () => {
      hasExited = true;
      resolve();
    });
  });
  const stop = async () => {
    if (hasExited) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (!hasExited) child.kill("SIGKILL");
    }, 5000);
    await exited;
    clearTimeout(timer);
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited) {
      throw new Error(`${executable} exited before DevTools started`);
    }
    const port = readDevToolsPort(profileDir);
    if (port != null) return { child, port, exited, stop };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error(`${executable} did not start DevTools within ${timeoutMs}ms`);
}

// The id in webSocketDebuggerUrl is unique per browser process, so matching it
// on both ends proves the project port reaches this browser.
export function devToolsBrowserId(versionJson: string): string | null {
  try {
    const url = JSON.parse(versionJson)?.webSocketDebuggerUrl;
    return `${url ?? ""}`.match(/\/devtools\/browser\/([^/?#]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}
