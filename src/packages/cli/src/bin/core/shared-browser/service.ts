/**
 * `cocalc project browser serve`: run the shared browser as a project app.
 * The app manager supplies PORT (the CLI's API port, on loopback); viewers
 * connect over conat with the project's credentials.
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
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  keyFingerprint,
  profileSecret,
  readBrowserKey,
  startBrowserKeyring,
  type BrowserKeyring,
} from "./keyring";
import {
  devToolsRequest,
  type DevToolsEndpoint,
  SharedBrowserServer,
} from "./server";
import { recentSites } from "./start-page";
import type { StartPageSite } from "@cocalc/util/shared-browser-protocol";
import { serveViewers } from "./viewer-socket";
import { openCurrentProjectConnection } from "../../../api/current-project";

import {
  formatSharedBrowserFile,
  parseSharedBrowserFile,
  SHARED_BROWSER_APP_ID,
  SHARED_BROWSER_FILE_APP_ID_RE,
  SHARED_BROWSER_KEY_SECRET,
  SHARED_BROWSER_RUN_DIR,
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
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
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
  { sandbox = false }: { sandbox?: boolean } = {},
): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    ...HIDE_AUTOMATION,
    "--headless=new",
    // Chromium's own sandbox needs namespaces that project containers
    // cannot create; a browser's own container can (see container-entry.ts).
    ...(sandbox ? [] : ["--no-sandbox"]),
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

  // Connect to CoCalc first: for viewers, and for the host, which runs the
  // browser in a container of its own.
  const projectId = currentProjectId();
  let client: any = null;
  try {
    ({ client } = await openCurrentProjectConnection({ projectId }));
  } catch (err: any) {
    // Agents can still use it; nobody can watch.
    log(`no viewers: cannot connect to CoCalc: ${err?.message ?? err}`);
  }
  // Projects started before their host could do that run it here.
  let isolate = !!client && !!projectId && existsSync(SHARED_BROWSER_RUN_DIR);
  const runDir = join(SHARED_BROWSER_RUN_DIR, profileId);

  const server = new SharedBrowserServer({
    host,
    port,
    cdpPort,
    // A .browser file's browser is the human's first.
    humanFirst: !!file,
    title: file ? basename(file) : "Web browser",
    recent: () => local?.recent() ?? [],
    offerFiles: (paths) => local?.offerFiles(paths) ?? paths,
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

  // Viewers (CoCalc's frontend) connect over conat, as to a terminal.
  const viewers = client
    ? serveViewers({
        client,
        server,
        projectId: projectId!,
        appId: profileId,
        log,
      })
    : null;

  // The browser, while it runs in the project or in its own container (not
  // on the user's computer).
  interface Local {
    // The project key it runs with (null: a temporary profile).
    keyId: string | null;
    pages(): Promise<string[]>;
    stop(): Promise<void>;
    recent(): StartPageSite[];
    // What a page's file chooser gets for these project files.
    offerFiles(paths: string[]): string[];
  }
  let local: Local | null = null;
  let stopping = false;

  // Sign-ins are kept only with the project's browser key: Chromium encrypts
  // cookies with it (see ./keyring.ts), and drops the ones it cannot
  // decrypt, so a kept profile never runs without the keyring.
  const describeKey = (keyring: BrowserKeyring | null) =>
    keyring
      ? "sign-ins encrypted with the project's browser key"
      : `no ${SHARED_BROWSER_KEY_SECRET} project secret, so sign-ins are not kept`;

  const startInProject = async (
    key: Buffer | null,
    urls?: string[],
  ): Promise<Local> => {
    const executable = findSharedBrowserChrome(chrome, sys);
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
    const endpoint = { host: `127.0.0.1:${browser.port}`, port: browser.port };
    const running: Local = {
      keyId: keyFingerprint(key),
      pages: () => openPageUrls(endpoint),
      recent: () => recentSites(join(profile.path, "Default", "History")),
      offerFiles: (paths) => paths,
      stop: async () => {
        server.detachChrome();
        await cleanupThenDisarm(
          [() => browser.stop(), () => profile.cleanup()],
          watchdog,
          (err) => log(`cleanup: ${(err as Error)?.message ?? err}`),
        );
        await keyring?.close().catch(() => {});
      },
    };
    // The app manager restarts the service on the next use.
    void browser.exited.then(() => {
      if (local === running && !stopping)
        void stop(
          `the browser exited (code ${browser.child.exitCode ?? browser.child.signalCode})\n${browser.stderrTail()}`,
        );
    });
    const version = JSON.parse(
      (await devToolsRequest(endpoint, "/json/version")).text,
    );
    await server.attachChrome(version.webSocketDebuggerUrl);
    log(
      `${version.Browser} in the project, without Chromium's sandbox; profile in ${profile.backing}; ${describeKey(keyring)}`,
    );
    return running;
  };

  const startInContainer = async (
    key: Buffer | null,
    urls?: string[],
  ): Promise<Local> => {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const keyring = key
      ? await startBrowserKeyring({
          secret: profileSecret(key, profileId),
          socketPath: join(runDir, "bus.sock"),
          log,
        })
      : null;
    const hostApi = client.call(`project.${projectId}.shared-browser.-`, {
      timeout: 150_000,
    });
    let info: { name: string; network: string; socket: string };
    try {
      info = await hostApi.start({
        appId: profileId,
        network: "own",
        keyFingerprint: keyFingerprint(key),
        urls,
      });
    } catch (err) {
      await keyring?.close().catch(() => {});
      throw err;
    }
    const endpoint = { socketPath: info.socket };
    let version: any = null;
    const deadline = Date.now() + 60_000;
    while (!version) {
      try {
        version = JSON.parse(
          (await devToolsRequest(endpoint, "/json/version")).text,
        );
      } catch (err) {
        if (Date.now() > deadline) {
          await hostApi.stop(profileId).catch(() => {});
          await keyring?.close().catch(() => {});
          throw Error(`the browser's container did not start: ${err}`);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const path = new URL(version.webSocketDebuggerUrl).pathname;
    await server.attachChrome(`ws+unix://${info.socket}:${path}`);
    log(
      `${version.Browser} in its own container (${info.network} network) with Chromium's sandbox; ${describeKey(keyring)}`,
    );
    return {
      keyId: keyFingerprint(key),
      pages: () => openPageUrls(endpoint),
      recent: () => readRecent(join(runDir, "recent.json")),
      offerFiles: (paths) => offerToContainer(paths, join(runDir, "exchange")),
      stop: async () => {
        server.detachChrome();
        await hostApi
          .stop(profileId)
          .catch((err: any) => log(`stop: ${err?.message ?? err}`));
        await keyring?.close().catch(() => {});
      },
    };
  };

  const startLocal = async (urls?: string[]) => {
    const key = readBrowserKey();
    if (isolate) {
      try {
        local = await startInContainer(key, urls);
        return;
      } catch (err: any) {
        // A host without the service (an older version) answers nobody.
        if (
          !/no responders|503/i.test(
            `${err?.code ?? ""} ${err?.message ?? err}`,
          )
        )
          throw err;
        log("this project's host cannot give the browser its own container");
        isolate = false;
      }
    }
    local = await startInProject(key, urls);
  };

  const stopLocal = async () => {
    const current = local;
    if (!current) return;
    local = null;
    await current.stop();
  };

  // The project's browser key was created, replaced or deleted: start over
  // in the right profile, with the same pages open.
  const restartLocal = async () => {
    const current = local;
    if (!current) return;
    const urls = await current.pages();
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
    viewers?.close();
    await stopLocal().catch(() => {});
    await server.close().catch(() => {});
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => void stop(signal));
  await new Promise(() => {});
}

// The start page's recent sites, which a browser in its own container
// writes for us (its profile is not in the project).
export function readRecent(path: string): StartPageSite[] {
  try {
    if (statSync(path).size > 256 * 1024) return [];
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (site: any) =>
          typeof site?.url === "string" &&
          /^https?:\/\//.test(site.url) &&
          typeof site?.title === "string",
      )
      .slice(0, 8)
      .map((site: any) => ({
        url: site.url.slice(0, 2000),
        title: site.title.slice(0, 60),
      }));
  } catch {
    return [];
  }
}

const MAX_OFFERED_BYTES = 1024 * 1024 * 1024;

/**
 * Project files for a page's file chooser, when the browser runs in its own
 * container, which sees none of the project's files: copies in the
 * directory it shares, under a new random name (never through anything the
 * browser may have put there), removed after a while.
 */
export function offerToContainer(paths: string[], exchange: string): string[] {
  let total = 0;
  for (const path of paths) total += statSync(path).size;
  if (total > MAX_OFFERED_BYTES)
    throw Error("these files are too large to upload");
  mkdirSync(exchange, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(exchange, "files-"));
  const offered = paths.map((path) => {
    const copy = join(dir, basename(path));
    copyFileSync(path, copy, fsConstants.COPYFILE_EXCL);
    return copy;
  });
  setTimeout(
    () => rmSync(dir, { recursive: true, force: true }),
    10 * 60_000,
  ).unref();
  return offered;
}

// The pages open in a browser, to reopen them in a restarted one.
async function openPageUrls(endpoint: DevToolsEndpoint): Promise<string[]> {
  try {
    const targets = JSON.parse(
      (await devToolsRequest(endpoint, "/json/list")).text,
    );
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
