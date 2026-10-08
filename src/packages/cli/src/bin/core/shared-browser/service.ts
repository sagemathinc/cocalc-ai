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
  type ProfileStorage,
} from "../local-browser";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { SharedBrowserServer } from "./server";

import {
  SHARED_BROWSER_APP_ID,
  SHARED_BROWSER_FILE_APP_ID_RE,
  sharedBrowserFileAppId,
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
  // A persistent profile (a .browser file's browser) instead of a temporary one.
  profileDir,
  log = (message: string) => console.error(`[shared-browser] ${message}`),
}: {
  port: number;
  host?: string;
  cdpPort?: number;
  chrome?: string;
  profileStorage?: ProfileStorage;
  profileDir?: string;
  log?: (message: string) => void;
}): Promise<void> {
  const sys = defaultLocalBrowserSystem();
  const executable = findSharedBrowserChrome(chrome, sys);
  const profile = profileDir
    ? persistentProfile(profileDir)
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
  const version = await (
    await fetch(`http://127.0.0.1:${browser.port}/json/version`)
  ).json();
  const server = new SharedBrowserServer({
    chromeWebSocketUrl: version.webSocketDebuggerUrl,
    host,
    port,
    cdpPort,
    log,
  });
  await server.start();
  log(`${version.Browser}; profile in ${profile.backing}`);

  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${reason}`);
    await cleanupThenDisarm(
      [() => server.close(), () => browser.stop(), () => profile.cleanup()],
      watchdog,
      (err) => log(`cleanup: ${(err as Error)?.message ?? err}`),
    );
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => void stop(signal));
  // The app manager restarts the service on the next use.
  void browser.exited.then(() =>
    stop(
      `the browser exited (code ${browser.child.exitCode ?? browser.child.signalCode})\n${browser.stderrTail()}`,
    ),
  );
  await new Promise(() => {});
}

function persistentProfile(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // Only this service uses the profile (the app manager runs one instance),
  // so a lock left by a browser that did not exit cleanly, e.g. when the
  // project stopped, is stale; Chromium would refuse to start.
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
    rmSync(join(path, name), { force: true });
  return {
    path,
    backing: `persistent directory ${path}`,
    cleanup: async () => {},
    release: {},
  };
}
