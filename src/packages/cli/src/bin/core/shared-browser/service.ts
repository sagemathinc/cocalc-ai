/**
 * `cocalc project browser serve`: run the shared browser as a project app.
 * The app manager supplies PORT (the viewer/API port behind the app proxy).
 */
import {
  cleanupThenDisarm,
  createProfileDir,
  defaultLocalBrowserSystem,
  findChrome,
  launchBrowser,
  startCleanupWatchdog,
  type LocalBrowserSystem,
  type ProfileDir,
  type ProfileStorage,
} from "../local-browser";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { SharedBrowserServer } from "./server";

import {
  formatSharedBrowserFile,
  parseSharedBrowserFile,
  SHARED_BROWSER_APP_ID,
  SHARED_BROWSER_FILE_APP_ID_RE,
  sharedBrowserFileAppId,
  sharedBrowserTunnelPort,
  type SharedBrowserRunsOn,
} from "@cocalc/util/shared-browser";

export { SHARED_BROWSER_APP_ID };

/**
 * Which shared browser a command means: the project's (chat) browser, or the
 * browser of a `.browser` file.  A file's browser is its own app, keeps its
 * profile (logins, cookies) across restarts, and is named by the file's
 * absolute path.
 */
export interface SharedBrowserTarget {
  appId: string;
  file: string | null;
}

export function sharedBrowserTarget(
  value: string | undefined,
  { cwd = process.cwd(), home = homedir() } = {},
): SharedBrowserTarget {
  const text = `${value ?? ""}`.trim();
  if (!text || text === SHARED_BROWSER_APP_ID)
    return { appId: SHARED_BROWSER_APP_ID, file: null };
  if (SHARED_BROWSER_FILE_APP_ID_RE.test(text))
    return { appId: text, file: null };
  if (!text.endsWith(".browser"))
    throw Error(
      `--browser must be a .browser file (or a shared browser app id), got '${text}'`,
    );
  const expanded =
    text === "~" || text.startsWith("~/") ? home + text.slice(1) : text;
  const file = isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(cwd, expanded);
  return { appId: sharedBrowserFileAppId(file), file };
}

// Where a .browser file's browser keeps its profile.
export function sharedBrowserProfileDir(appId: string, home = homedir()) {
  return join(home, ".local", "share", "cocalc", "browser-profiles", appId);
}

export const INSTALL_CHROMIUM_HINT =
  "No Chromium found: this project's CoCalc tools predate the bundled browser. Restart the project after the host's tools are updated, or install one with: cocalc rootfs recipe run cocalc/chromium --here";

// The headless Chromium in the project tools bundle (see
// project/sea/install-chromium.sh), next to this CLI in /opt/cocalc/bin2.
export const BUNDLED_CHROMIUM = "/opt/cocalc/bin2/cocalc-chromium/chromium";

export function bundledChromiumCandidates(
  script: string | undefined = process.argv[1],
): string[] {
  const candidates = [BUNDLED_CHROMIUM];
  if (script) {
    const sibling = join(dirname(script), "cocalc-chromium", "chromium");
    if (sibling !== BUNDLED_CHROMIUM) candidates.unshift(sibling);
  }
  return candidates;
}

export function findSharedBrowserChrome(
  chrome: string | undefined,
  sys: Pick<
    LocalBrowserSystem,
    "platform" | "env" | "home" | "exists"
  > = defaultLocalBrowserSystem(),
  script: string | undefined = process.argv[1],
): string {
  // An explicit choice wins; otherwise prefer the bundled browser, which is
  // the one we test, over whatever the image happens to have.
  if (!chrome && !`${sys.env.COCALC_CHROME ?? ""}`.trim()) {
    if (sys.platform === "linux") {
      const bundled = bundledChromiumCandidates(script).find((path) =>
        sys.exists(path),
      );
      if (bundled) return bundled;
    }
  }
  try {
    return findChrome(chrome, sys);
  } catch (err) {
    if (chrome || sys.env.COCALC_CHROME) throw err;
    throw new Error(INSTALL_CHROMIUM_HINT);
  }
}

// As Puppeteer and Playwright do: without these, headless Chromium may stop
// producing frames or acknowledging input for a page it considers hidden.
const NO_THROTTLING = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

export function sharedBrowserChromeArgs(profileDir: string): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--headless=new",
    // Project containers cannot create the namespaces Chromium's sandbox
    // needs.  The project is the security boundary (see the README).
    "--no-sandbox",
    "--disable-gpu",
    // Containers give /dev/shm only a few MB; use /tmp for shared memory.
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disk-cache-size=67108864",
    "--window-size=1280,800",
    ...NO_THROTTLING,
    "about:blank",
  ];
}

export async function runSharedBrowserService({
  port,
  host = "127.0.0.1",
  cdpPort = 9222,
  chrome,
  // In a project, /tmp is wiped when the project stops and is neither backed
  // up nor shared; /dev/shm is too small for a browser profile.
  profileStorage = "disk",
  // A .browser file's browser: the file (absolute path) and its app id.
  file,
  appId,
  log = (message: string) => console.error(`[shared-browser] ${message}`),
}: {
  port: number;
  host?: string;
  cdpPort?: number;
  chrome?: string;
  profileStorage?: ProfileStorage;
  file?: string | null;
  appId?: string;
  log?: (message: string) => void;
}): Promise<void> {
  const sys = defaultLocalBrowserSystem();
  const readRunsOn = (): SharedBrowserRunsOn =>
    file && existsSync(file)
      ? parseSharedBrowserFile(readFileSync(file, "utf8")).runs_on
      : "project";
  let runsOn: SharedBrowserRunsOn = file ? readRunsOn() : "project";
  const tunnelPort = file && appId ? sharedBrowserTunnelPort(appId) : null;

  const server = new SharedBrowserServer({
    host,
    port,
    cdpPort,
    // A .browser file's browser is the human's first.
    humanFirst: !!file,
    ...(file
      ? {
          runsOn,
          connectCommand: connectCommandFor(file),
          onRunsOn: (value) => switchTo(value, true),
        }
      : {}),
    log,
  });
  await server.start();

  // The browser in the project, while the file says it runs here.
  let local: {
    browser: Awaited<ReturnType<typeof launchBrowser>>;
    profile: Pick<ProfileDir, "path" | "backing" | "cleanup" | "release">;
    watchdog: ReturnType<typeof startCleanupWatchdog>;
  } | null = null;
  let stopping = false;

  const startLocal = async () => {
    const executable = findSharedBrowserChrome(chrome, sys);
    const profile =
      file && appId
        ? persistentProfile(sharedBrowserProfileDir(appId))
        : await createProfileDir(profileStorage, sys);
    const browser = await launchBrowser({
      executable,
      profileDir: profile.path,
      args: sharedBrowserChromeArgs(profile.path),
      captureStderr: true,
    });
    const watchdog = startCleanupWatchdog({
      browser: browser.child.pid!,
      browserMarker: `--user-data-dir=${profile.path}`,
      release: profile.release,
    });
    local = { browser, profile, watchdog };
    const current = local;
    // The app manager restarts the service on the next use.
    void browser.exited.then(() => {
      if (local === current && !stopping)
        void stop(
          `the browser exited (code ${browser.child.exitCode ?? browser.child.signalCode})\n${browser.stderrTail()}`,
        );
    });
    const version = await (
      await fetch(`http://127.0.0.1:${browser.port}/json/version`)
    ).json();
    await server.attachChrome(version.webSocketDebuggerUrl);
    log(`${version.Browser}; profile in ${profile.backing}`);
  };

  const stopLocal = async () => {
    const current = local;
    if (!current) return;
    local = null;
    server.detachChrome();
    await cleanupThenDisarm(
      [() => current.browser.stop(), () => current.profile.cleanup()],
      current.watchdog,
      (err) => log(`cleanup: ${(err as Error)?.message ?? err}`),
    );
  };

  // The user's computer, through the reverse tunnel of
  // `cocalc project browser connect --browser <file>`.
  const remoteVersion = async (): Promise<any | null> => {
    if (!tunnelPort) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${tunnelPort}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const attachRemote = async () => {
    const version = await remoteVersion();
    if (!version?.webSocketDebuggerUrl) return false;
    // It reports its own port on the computer; we reach it through ours.
    const url = `${version.webSocketDebuggerUrl}`.replace(
      /^ws:\/\/[^/]+/,
      `ws://127.0.0.1:${tunnelPort}`,
    );
    await server.attachChrome(url);
    log(`attached to ${version.Browser} on the user's computer`);
    return true;
  };

  let switching: Promise<void> = Promise.resolve();
  const switchTo = (value: SharedBrowserRunsOn, write: boolean) => {
    switching = switching
      .then(async () => {
        if (write && file && readRunsOn() !== value)
          writeFileSync(file, formatSharedBrowserFile({ runs_on: value }));
        if (value === runsOn && (value === "computer" || local)) return;
        runsOn = value;
        server.setRunsOn(value);
        log(`runs on: ${value}`);
        if (value === "computer") {
          await stopLocal();
          await attachRemote();
        } else {
          server.detachChrome();
          await startLocal();
        }
      })
      .catch((err) => log(`switch: ${err?.message ?? err}`));
    return switching;
  };

  if (runsOn === "project") await startLocal();
  else await attachRemote();

  // Follow the file (the viewer, an edit, or `connect` may change it), and
  // the tunnel: a computer that connects takes over the file's browser.
  const poll = setInterval(() => {
    switching = switching
      .then(async () => {
        if (stopping || !file) return;
        const fromFile = readRunsOn();
        if (fromFile !== runsOn) {
          void switchTo(fromFile, false);
          return;
        }
        if (runsOn === "computer" && !server.attached) await attachRemote();
        else if (runsOn === "project" && tunnelPort && (await remoteVersion()))
          void switchTo("computer", true);
      })
      .catch((err) => log(`poll: ${err?.message ?? err}`));
  }, 2000);

  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(poll);
    log(`stopping: ${reason}`);
    await stopLocal().catch(() => {});
    await server.close().catch(() => {});
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => void stop(signal));
  await new Promise(() => {});
}

// What the user runs on their computer to connect it to this file's browser.
export function connectCommandFor(
  file: string,
  projectId = process.env.COCALC_PROJECT_ID,
): string {
  const quoted = /^[\w./~-]+$/.test(file)
    ? file
    : `'${file.replace(/'/g, "'\\''")}'`;
  return `cocalc project browser connect${projectId ? ` -w ${projectId}` : ""} --browser ${quoted}`;
}

export function persistentProfile(path: string): ProfileDir {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // Only this service uses the profile (the app manager runs one instance),
  // so a lock left by a browser that did not exit cleanly, e.g. when the
  // project stopped, is stale; Chromium would refuse to start.
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
    rmSync(join(path, name), { force: true });
  return {
    path,
    storage: "disk" as const,
    backing: `persistent directory ${path}`,
    cleanup: async () => {},
    release: {},
  };
}
