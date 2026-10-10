/**
 * `cocalc project browser container-entry`: what a shared browser's own
 * container runs (the project host starts it; see
 * project-host/shared-browser-containers.ts).  It starts Chromium with its
 * own sandbox, and makes its DevTools reachable only through a unix socket
 * in the directory the container shares with the project
 * (/run/cocalc-browser/<appId>); `serve` in the project connects there.
 *
 * In that directory: cdp.sock (ours), bus.sock (the project's keyring,
 * served by `serve`), recent.json (ours, for the start page), exchange/
 * (files `serve` offers to a page's file chooser).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  createProfileDir,
  defaultLocalBrowserSystem,
  launchBrowser,
} from "../local-browser";
import { recentSites } from "./start-page";
import {
  findSharedBrowserChrome,
  persistentProfile,
  sharedBrowserChromeArgs,
} from "./service";

const KEY_MARKER = ".cocalc-browser-key";

export interface ContainerEntryOptions {
  // This browser's directory shared with the project.
  runDir: string;
  // This browser's profile (persistent), when the project has a browser key.
  profileDir?: string;
  // The project's browser key fingerprint: a profile made with another key
  // is wiped (its cookies could not be read anyway).
  keyFingerprint?: string;
  urls?: string[];
  chrome?: string;
  log?: (message: string) => void;
}

/** Start over with an empty profile if it is not this key's. */
export function profileForFingerprint(path: string, fingerprint: string) {
  let have: string | null = null;
  try {
    have = readFileSync(join(path, KEY_MARKER), "utf8").trim();
  } catch {}
  if (have === fingerprint) return false;
  rmSync(path, { recursive: true, force: true, maxRetries: 10 });
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, KEY_MARKER), `${fingerprint}\n`);
  return true;
}

export async function runBrowserContainerEntry({
  runDir,
  profileDir,
  keyFingerprint,
  urls,
  chrome,
  log = (message: string) => console.error(`[browser-container] ${message}`),
}: ContainerEntryOptions): Promise<void> {
  const sys = defaultLocalBrowserSystem();
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const kept = !!(profileDir && keyFingerprint);
  if (kept && profileForFingerprint(profileDir!, keyFingerprint!))
    log("a profile for another key: started over");
  const profile = kept
    ? persistentProfile(profileDir!)
    : await createProfileDir("disk", sys);
  const env = kept
    ? {
        ...process.env,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runDir, "bus.sock")}`,
      }
    : { ...process.env };
  const executable = findSharedBrowserChrome(chrome, sys);
  const launch = (sandbox: boolean) =>
    launchBrowser({
      executable,
      profileDir: profile.path,
      args: sharedBrowserChromeArgs(profile.path, urls, { sandbox }),
      captureStderr: true,
      env,
    });
  let browser: Awaited<ReturnType<typeof launchBrowser>>;
  try {
    browser = await launch(true);
  } catch (err: any) {
    // Where the namespaces it needs are missing, the container is the only
    // isolation left; say so.
    log(
      `Chromium's sandbox is unavailable here, so this container is the browser's only isolation: ${`${err?.message ?? err}`.slice(0, 500)}`,
    );
    browser = await launch(false);
  }
  log(`Chromium on its loopback port ${browser.port}`);

  // Agents and the viewer reach Chromium only through this socket.
  const socketPath = join(runDir, "cdp.sock");
  rmSync(socketPath, { force: true });
  const sockets = new Set<Socket>();
  const relay = createServer((client) => {
    const upstream = createConnection(browser.port, "127.0.0.1");
    sockets.add(client).add(upstream);
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
  });
  await new Promise<void>((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(socketPath, () => resolve());
  });

  // The start page's recent sites: the profile is not in the project.
  const writeRecent = () => {
    try {
      const recent = recentSites(join(profile.path, "Default", "History"));
      const tmp = join(runDir, `.recent-${randomBytes(6).toString("hex")}`);
      writeFileSync(tmp, JSON.stringify(recent), { flag: "wx", mode: 0o600 });
      renameSync(tmp, join(runDir, "recent.json"));
    } catch {}
  };
  writeRecent();
  const recentTimer = setInterval(writeRecent, 15_000);

  let stopping = false;
  const stop = async (reason: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${reason}`);
    clearInterval(recentTimer);
    relay.close();
    for (const socket of sockets) socket.destroy();
    await browser.stop().catch(() => {});
    await profile.cleanup().catch(() => {});
    rmSync(socketPath, { force: true });
    process.exit(code);
  };
  void browser.exited.then(() =>
    stop(
      `Chromium exited (${browser.child.exitCode ?? browser.child.signalCode})\n${browser.stderrTail()}`,
      1,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => void stop(signal));
  if (!existsSync(socketPath)) await stop("the socket vanished", 1);
  await new Promise(() => {});
}
