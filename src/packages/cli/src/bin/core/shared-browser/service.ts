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
  HIDE_AUTOMATION,
  type ProfileDir,
  type ProfileStorage,
} from "../local-browser";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  keyFingerprint,
  profileSecret,
  readBrowserKey,
  startBrowserKeyring,
  type BrowserKeyring,
} from "./keyring";
import { SharedBrowserServer } from "./server";

import {
  formatSharedBrowserFile,
  parseSharedBrowserFile,
  SHARED_BROWSER_APP_ID,
  SHARED_BROWSER_FILE_APP_ID_RE,
  SHARED_BROWSER_KEY_SECRET,
  sharedBrowserFileAppId,
  sharedBrowserTunnelPort,
  type SharedBrowserRunsOn,
} from "@cocalc/util/shared-browser";

export { SHARED_BROWSER_APP_ID };

/**
 * Which shared browser a command means: the project's (chat) browser, or the
 * browser of a `.browser` file.  A file's browser is its own app with its own
 * profile, and is named by the file's absolute path.
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

// Where a browser keeps its profile (sign-ins, history) across restarts.
export function sharedBrowserProfileDir(appId: string, home = homedir()) {
  return join(home, ".local", "share", "cocalc", "browser-profiles", appId);
}

const KEY_MARKER = ".cocalc-browser-key";

/**
 * Make the profile at path one for this key.  A profile from another key (the
 * project's browser key was replaced or deleted since) has sign-ins nobody
 * can read, and one from before keys has sign-ins anybody can read: start
 * over.  Returns whether it removed an old profile.
 */
export function profileForKey(path: string, secret: Buffer): boolean {
  const want = keyFingerprint(secret)!;
  let have: string | null = null;
  try {
    have = readFileSync(join(path, KEY_MARKER), "utf8").trim();
  } catch {}
  if (have === want) return false;
  const existed = existsSync(path) && readdirSync(path).length > 0;
  removeProfile(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, KEY_MARKER), `${want}\n`);
  return existed;
}

function removeProfile(path: string) {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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

export function sharedBrowserChromeArgs(
  profileDir: string,
  urls: string[] = ["about:blank"],
): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    ...HIDE_AUTOMATION,
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
    ...urls,
  ];
}

export async function runSharedBrowserService({
  port,
  host = "127.0.0.1",
  cdpPort = 9222,
  chrome,
  // Without the project's browser key, the profile is temporary.  In a
  // project, /tmp is wiped when the project stops and is neither backed up
  // nor shared; /dev/shm is too small for a browser profile.
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
  const profileId = appId ?? SHARED_BROWSER_APP_ID;

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
    keyring: BrowserKeyring | null;
    // The project key it runs with (null: a temporary profile).
    keyId: string | null;
  } | null = null;
  let stopping = false;

  const startLocal = async (urls?: string[]) => {
    const executable = findSharedBrowserChrome(chrome, sys);
    // Sign-ins are kept only with the project's browser key: Chromium
    // encrypts cookies with it (see ./keyring.ts), and drops the ones it
    // cannot decrypt, so a kept profile never runs without the keyring.
    const key = readBrowserKey();
    let keyring: BrowserKeyring | null = null;
    let profile: Pick<ProfileDir, "path" | "backing" | "cleanup" | "release">;
    if (key) {
      const secret = profileSecret(key, profileId);
      const path = sharedBrowserProfileDir(profileId);
      if (profileForKey(path, secret))
        log("the browser key changed: removed the old profile");
      profile = persistentProfile(path);
      keyring = await startBrowserKeyring({ secret, log });
    } else {
      profile = await createProfileDir(profileStorage, sys);
    }
    let browser: Awaited<ReturnType<typeof launchBrowser>>;
    try {
      browser = await launchBrowser({
        executable,
        profileDir: profile.path,
        args: sharedBrowserChromeArgs(profile.path, urls),
        captureStderr: true,
        env: keyring
          ? { ...process.env, DBUS_SESSION_BUS_ADDRESS: keyring.address }
          : undefined,
      });
    } catch (err) {
      await keyring?.close();
      throw err;
    }
    const watchdog = startCleanupWatchdog({
      browser: browser.child.pid!,
      browserMarker: `--user-data-dir=${profile.path}`,
      release: profile.release,
    });
    local = { browser, profile, watchdog, keyring, keyId: keyFingerprint(key) };
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
    log(
      `${version.Browser}; profile in ${profile.backing}; ${
        keyring
          ? "sign-ins encrypted with the project's browser key"
          : `no ${SHARED_BROWSER_KEY_SECRET} project secret, so sign-ins are not kept`
      }`,
    );
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
    await current.keyring?.close().catch(() => {});
  };

  // The project's browser key was created, replaced or deleted: start over
  // in the right profile, with the same pages open.
  const restartLocal = async () => {
    const current = local;
    if (!current) return;
    const urls = await openPageUrls(current.browser.port);
    await stopLocal();
    // Deleted: forget everything this browser kept.
    if (!readBrowserKey()) removeProfile(sharedBrowserProfileDir(profileId));
    await startLocal(urls.length > 0 ? urls : undefined);
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

  // Follow the project's browser key; and the file (the viewer, an edit, or
  // `connect` may change it) and the tunnel: a computer that connects takes
  // over the file's browser.
  const poll = setInterval(() => {
    switching = switching
      .then(async () => {
        if (stopping) return;
        if (local && keyFingerprint(readBrowserKey()) !== local.keyId) {
          log("the project's browser key changed: restarting the browser");
          await restartLocal();
          return;
        }
        if (!file) return;
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

// The pages open in a browser, to reopen them in a restarted one.
async function openPageUrls(port: number): Promise<string[]> {
  try {
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      })
    ).json();
    return targets
      .filter(
        (t: any) => t.type === "page" && /^https?:/.test(`${t.url ?? ""}`),
      )
      .map((t: any) => `${t.url}`);
  } catch {
    return [];
  }
}

// Inside a project: its id (apps may not get COCALC_PROJECT_ID; the
// project's hostname is project-<id>).
export function currentProjectId(
  env: NodeJS.ProcessEnv = process.env,
  host: string = hostname(),
): string | undefined {
  const id = `${env.COCALC_PROJECT_ID ?? ""}`.trim();
  if (id) return id;
  return host.match(
    /^project-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  )?.[1];
}

// What the user runs on their computer to connect it to this file's browser.
export function connectCommandFor(
  file: string,
  projectId = currentProjectId(),
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
