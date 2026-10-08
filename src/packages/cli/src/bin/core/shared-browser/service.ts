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
import { dirname, join } from "node:path";

import { SharedBrowserServer } from "./server";

export const SHARED_BROWSER_APP_ID = "cocalc-browser";

export const INSTALL_CHROMIUM_HINT =
  "No Chromium found: this project's CoCalc tools predate the bundled browser. Restart the project after the host's tools are updated, or install one with: cocalc rootfs recipe run cocalc/chromium --here";

// The headless Chromium in the project tools bundle (see
// project/sea/install-chromium.sh), next to this CLI in /opt/cocalc/bin2.
export const BUNDLED_CHROMIUM = "/opt/cocalc/bin2/chromium/chromium";

export function bundledChromiumCandidates(
  script: string | undefined = process.argv[1],
): string[] {
  const candidates = [BUNDLED_CHROMIUM];
  if (script) {
    const sibling = join(dirname(script), "chromium", "chromium");
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
  log = (message: string) => console.error(`[shared-browser] ${message}`),
}: {
  port: number;
  host?: string;
  cdpPort?: number;
  chrome?: string;
  profileStorage?: ProfileStorage;
  log?: (message: string) => void;
}): Promise<void> {
  const sys = defaultLocalBrowserSystem();
  const executable = findSharedBrowserChrome(chrome, sys);
  const profile = await createProfileDir(profileStorage, sys);
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
