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
  type ProfileStorage,
} from "../local-browser";
import { SharedBrowserServer } from "./server";

export const SHARED_BROWSER_APP_ID = "cocalc-browser";

export const INSTALL_CHROMIUM_HINT =
  "Chromium is not installed in this project. Install it with: cocalc rootfs recipe run cocalc/chromium --here";

export function findSharedBrowserChrome(
  chrome: string | undefined,
  sys = defaultLocalBrowserSystem(),
): string {
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
  void browser.exited.then(() => stop("the browser exited"));
  await new Promise(() => {});
}
