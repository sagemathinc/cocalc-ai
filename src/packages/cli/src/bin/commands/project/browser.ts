/**
 * `cocalc project browser connect`: a private local browser that agents in
 * the project can drive over the Chrome DevTools Protocol.
 *
 * Runs in the foreground on the user's computer.  Chrome gets a throwaway
 * profile (in RAM by default) and DevTools on a free loopback port; a
 * reflect-sync reverse forward makes that port reachable at
 * 127.0.0.1:<port> inside the project, and only there.  Closing the browser
 * or Ctrl-C removes the forward and the profile.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Command } from "commander";

import {
  chromeLaunchArgs,
  createProfileDir,
  defaultLocalBrowserSystem,
  devToolsBrowserId,
  findChrome,
  launchBrowser,
  type LaunchedBrowser,
  type ProfileDir,
  type ProfileStorage,
  cleanupThenDisarm,
  type CleanupWatchdog,
  startCleanupWatchdog,
  startUrl,
} from "../../core/local-browser";
import {
  localToProjectForwardArgs,
  reflectSupportsRemoteBind,
} from "../../core/reflect-forward-args";
import type { ProjectCommandDeps } from "../project";
import {
  ensureManagedProjectSshConfigEntry,
  managedProjectSshAlias,
} from "./ssh-config";

// DevTools is full control of a browser running as the local user.  The
// throwaway profile protects existing cookies and history, not the machine.
const TRUST_WARNING = [
  "Warning: anything running in the project (its agents, and processes of its",
  "collaborators) gets full control of this browser. It can open files on this",
  "computer and addresses on its local network, and read what the browser can",
  "read. Only connect projects you trust.",
].join("\n");

const FORWARD_NAME = /^cocalc-browser-([0-9a-f]{8})-(\d+)-(\d+)$/i;
const VERIFY_TIMEOUT_MS = 45_000;

type ConnectOptions = {
  project?: string;
  port?: string;
  chrome?: string;
  profileStorage?: string;
  url?: string;
  headless?: boolean;
  direct?: boolean;
  compress?: boolean;
  keyPath?: string;
  installKey?: boolean;
};

export function browserForwardName(
  projectId: string,
  projectPort: number,
  pid: number,
): string {
  return `cocalc-browser-${projectId.slice(0, 8)}-${projectPort}-${pid}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// Forwards left by an earlier `connect` for the same project port.  Those
// whose process is gone are stale (it crashed); a live one owns the port.
export function existingBrowserForwards(
  rows: Array<{ id: number; name?: string | null }>,
  projectId: string,
  projectPort: number,
  isAlive: (pid: number) => boolean = pidAlive,
): { stale: number[]; ownerPid: number | null } {
  const stale: number[] = [];
  let ownerPid: number | null = null;
  for (const row of rows) {
    const match = `${row.name ?? ""}`.match(FORWARD_NAME);
    if (!match) continue;
    if (match[1].toLowerCase() !== projectId.slice(0, 8).toLowerCase()) {
      continue;
    }
    if (Number(match[2]) !== projectPort) continue;
    const pid = Number(match[3]);
    if (pid !== process.pid && isAlive(pid)) {
      ownerPid = pid;
    } else {
      stale.push(row.id);
    }
  }
  return { stale, ownerPid };
}

function parseStorage(value: string | undefined): ProfileStorage {
  const storage = `${value ?? "memory"}`.trim().toLowerCase();
  if (storage !== "memory" && storage !== "disk") {
    throw new Error("--profile-storage must be 'memory' or 'disk'");
  }
  return storage;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 9222);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return port;
}

// /json/version is a few hundred bytes; whatever answers on the project port
// is not trusted, so never buffer more than this.
export const MAX_PROBE_RESPONSE_BYTES = 64 * 1024;

export type ProbeResult =
  | { kind: "none" } // nothing answered (yet)
  | { kind: "answered"; response: string }
  | { kind: "too-large" }; // more than MAX_PROBE_RESPONSE_BYTES: not a browser

// GET /json/version from 127.0.0.1:<port> inside the project through an ssh
// direct-tcpip channel (ssh -W), so nothing has to be installed there.
export function fetchProjectDevToolsVersion(
  alias: string,
  projectPort: number,
  abort: AbortSignal,
  spawnProbe: (args: string[]) => ChildProcess = (args) =>
    spawn("ssh", args, { stdio: ["pipe", "pipe", "ignore"] }),
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    if (abort.aborted) return resolve({ kind: "none" });
    const child = spawnProbe(["-W", `127.0.0.1:${projectPort}`, alias]);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const done = (result?: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      resolve(
        result ??
          (bytes > 0
            ? {
                kind: "answered",
                response: Buffer.concat(chunks).toString("utf8"),
              }
            : { kind: "none" }),
      );
    };
    const onAbort = () => done({ kind: "none" });
    const timer = setTimeout(() => done(), 20_000);
    abort.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_PROBE_RESPONSE_BYTES) {
        done({ kind: "too-large" });
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => done());
    child.on("close", () => done());
    child.stdin?.on("error", () => {});
    child.stdin?.write(
      `GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:${projectPort}\r\nConnection: close\r\n\r\n`,
    );
  });
}

// Wait until the project port answers with *this* browser's DevTools id.
// Fails closed: never reports success without matching the id.
async function verifyProjectSeesBrowser({
  alias,
  projectPort,
  localPort,
  abort,
}: {
  alias: string;
  projectPort: number;
  localPort: number;
  abort: AbortSignal;
}): Promise<void> {
  const local = await fetch(`http://127.0.0.1:${localPort}/json/version`);
  const localId = devToolsBrowserId(await local.text());
  if (!localId) {
    throw new Error("could not read the local browser's DevTools id");
  }
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (abort.aborted) throw new Error("verification cancelled");
    const response = await fetchProjectDevToolsVersion(
      alias,
      projectPort,
      abort,
    );
    if (abort.aborted) throw new Error("verification cancelled");
    if (response.kind !== "none") {
      if (response.kind === "answered") {
        const text = response.response;
        const body = text.slice(text.indexOf("\r\n\r\n") + 4);
        if (devToolsBrowserId(body) === localId) return;
      }
      throw new Error(
        `port ${projectPort} in the project is already used by another program; choose a different --port`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `the project did not reach the browser on port ${projectPort} within ${VERIFY_TIMEOUT_MS / 1000}s`,
  );
}

async function runBrowserConnect(
  ctx: any,
  deps: ProjectCommandDeps,
  opts: ConnectOptions,
) {
  const {
    resolveProjectSshConnection,
    ensureSyncKeyPair,
    installSyncPublicKey,
    normalizeProjectSshConfigPath,
    normalizeProjectSshHostAlias,
    removeProjectSshConfigBlock,
    projectSshConfigBlockMarkers,
    resolveCloudflaredBinary,
    reflectSyncCliInvocation,
    runReflectSyncCli,
    listReflectForwards,
    parseCreatedForwardId,
    terminateReflectForwards,
  } = deps;
  const storage = parseStorage(opts.profileStorage);
  const projectPort = parsePort(opts.port);
  const url = startUrl(opts.url);
  const sys = defaultLocalBrowserSystem();
  const executable = findChrome(opts.chrome, sys);
  const say = (line: string) => {
    if (!ctx.globals.json && ctx.globals.output !== "json") {
      console.error(line);
    }
  };

  say(TRUST_WARNING);

  // Without --remote-bind the forwarded DevTools port would listen on every
  // interface of the project; refuse rather than fall back.
  const help = await runReflectSyncCli(["forward", "create", "--help"]);
  if (!reflectSupportsRemoteBind(`${help.stdout}\n${help.stderr}`)) {
    throw new Error(
      "the installed reflect-sync cannot restrict the project-side port to 127.0.0.1 (needs `forward create --remote-bind`); upgrade @cocalc/cli",
    );
  }

  const route = await resolveProjectSshConnection(ctx, opts.project, {
    direct: !!opts.direct,
  });
  const projectId: string = route.project.project_id;
  let keyPath: string | null = null;
  if (opts.installKey !== false) {
    const keyInfo = await ensureSyncKeyPair(opts.keyPath);
    await installSyncPublicKey({
      ctx,
      projectIdentifier: projectId,
      publicKey: keyInfo.public_key,
    });
    keyPath = keyInfo.private_key_path;
  }
  const alias = normalizeProjectSshHostAlias(managedProjectSshAlias(projectId));
  ensureManagedProjectSshConfigEntry({
    configPath: normalizeProjectSshConfigPath(),
    alias,
    route: {
      ssh_transport: route.transport,
      ssh_username: route.ssh_username,
      cloudflare_hostname: route.cloudflare_hostname,
      ssh_host: route.ssh_host,
      ssh_port: route.ssh_port,
    },
    keyPath,
    cloudflaredBinary:
      route.transport !== "direct" ? resolveCloudflaredBinary() : null,
    removeProjectSshConfigBlock,
    projectSshConfigBlockMarkers,
  });

  const existing = existingBrowserForwards(
    await listReflectForwards(),
    projectId,
    projectPort,
  );
  if (existing.ownerPid != null) {
    throw new Error(
      `another 'cocalc project browser connect' (pid ${existing.ownerPid}) already uses project port ${projectPort}; close that browser or choose a different --port`,
    );
  }
  await terminateReflectForwards(existing.stale.map(String));

  let stopRequested: (signal: string) => void = () => {};
  const stopped = new Promise<string>((resolve) => (stopRequested = resolve));
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const onSignal = (signal: NodeJS.Signals) => stopRequested(signal);
  for (const signal of signals) process.on(signal, onSignal);

  const name = browserForwardName(projectId, projectPort, process.pid);
  let profile: ProfileDir | null = null;
  let browser: LaunchedBrowser | null = null;
  // Set once creation is attempted: reflect may store the row even when
  // starting it fails, so cleanup falls back to the (unique) name.
  let forwardRef: string | null = null;
  let watchdog: CleanupWatchdog | null = null;
  const verification = new AbortController();
  let endedBy = "browser closed";
  let cleanedUp = false;
  try {
    profile = await createProfileDir(storage, sys);
    browser = await launchBrowser({
      executable,
      profileDir: profile.path,
      args: chromeLaunchArgs({
        profileDir: profile.path,
        url,
        headless: opts.headless,
      }),
    });
    // If this process dies without reaching `finally` (crash, SIGKILL), the
    // detached browser and reflect's persistent forward would keep giving the
    // project control of the browser; the watchdog tears both down.
    watchdog = startCleanupWatchdog({
      browser: browser.child.pid!,
      browserMarker: `--user-data-dir=${profile.path}`,
      release: profile.release,
      forward: reflectSyncCliInvocation(["forward", "remove", name, "--stop"]),
    });
    forwardRef = name;
    let created;
    try {
      created = await runReflectSyncCli(
        localToProjectForwardArgs({
          sshTarget: alias,
          projectPort,
          localPort: browser.port,
          name,
          compress: opts.compress,
        }),
      );
    } catch (err) {
      // With ExitOnForwardFailure, ssh exits at once when the project side
      // cannot listen, most often because the port is taken.
      throw new Error(
        `could not open port ${projectPort} in the project (is it already in use? try a different --port): ${(err as Error)?.message ?? err}`,
      );
    }
    const forwardId = parseCreatedForwardId(
      `${created.stdout}\n${created.stderr}`,
    );
    if (forwardId != null) forwardRef = String(forwardId);
    say(`Connecting the browser to project ${projectId}...`);
    const verifying = verifyProjectSeesBrowser({
      alias,
      projectPort,
      localPort: browser.port,
      abort: verification.signal,
    }).then(() => "verified" as const);
    // It may still settle after the race is decided by a signal or exit.
    verifying.catch(() => {});
    const verified = await Promise.race([
      verifying,
      browser.exited.then(() => "closed" as const),
      stopped,
    ]);
    if (verified === "closed") {
      throw new Error("the browser closed before the project reached it");
    }
    if (verified !== "verified") {
      endedBy = verified;
    } else {
      say(
        [
          `Browser ready: agents in the project can use http://127.0.0.1:${projectPort} (Chrome DevTools Protocol).`,
          storage === "memory"
            ? `Profile is in RAM (${profile.backing}) and is discarded on exit.`
            : `Profile is a temporary directory (${profile.path}), deleted on exit.`,
          "Close the browser or press Ctrl-C to end the session.",
        ].join("\n"),
      );
      const signal = await Promise.race([
        browser.exited.then(() => null),
        stopped,
      ]);
      if (signal) endedBy = signal;
    }
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    verification.abort();
    cleanedUp = await cleanupThenDisarm(
      [
        () =>
          forwardRef != null
            ? terminateReflectForwards([forwardRef]).catch((err: unknown) => {
                // A name with no stored row means creation never got that far.
                if (forwardRef !== name) throw err;
              })
            : Promise.resolve(),
        () => browser?.stop() ?? Promise.resolve(),
        () => profile?.cleanup() ?? Promise.resolve(),
      ],
      watchdog,
      (err) => say(`cleanup: ${(err as Error)?.message ?? err}`),
    );
  }
  say(
    cleanedUp
      ? "Browser session ended; forward and profile removed."
      : "Browser session ended; cleanup failed and was handed to the watchdog.",
  );
  return {
    project_id: projectId,
    project_port: projectPort,
    browser: executable,
    profile_storage: storage,
    profile_backing: profile?.backing ?? null,
    forward_name: name,
    ended_by: endedBy,
  };
}

export function registerProjectBrowserCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const { withContext } = deps;
  const browser = project
    .command("browser")
    .description(
      "a browser on this computer that agents in the project can drive",
    );

  browser
    .command("connect")
    .description(
      "launch a private local Chrome/Chromium whose DevTools endpoint is reachable at 127.0.0.1:<port> inside the project until the browser closes. Anything in the project then fully controls that browser, including opening local files and local-network addresses: only connect projects you trust",
    )
    .option("-w, --project <project>", "project id or name")
    .option("--port <port>", "project port for the DevTools endpoint", "9222")
    .option(
      "--chrome <path>",
      "browser executable (default: $COCALC_CHROME or auto-detect Chrome, Chromium, Edge, Brave)",
    )
    .option(
      "--profile-storage <where>",
      "memory: the profile lives in RAM and never touches disk; disk: a temporary directory. Either way it is deleted on exit",
      "memory",
    )
    .option(
      "--url <url>",
      "page to open first (http, https or about)",
      "about:blank",
    )
    .option("--headless", "run the browser without a window")
    .option(
      "--direct",
      "bypass the Cloudflare ssh hostname and use the direct host ssh endpoint",
    )
    .option("--compress", "enable SSH compression for the tunnel")
    .option(
      "--key-path <path>",
      "ssh key base path (default: ~/.ssh/id_ed25519)",
    )
    .option(
      "--no-install-key",
      "skip automatic local ssh key ensure + project authorized_keys install",
    )
    .action(async (opts: ConnectOptions, command: Command) => {
      await withContext(command, "project browser connect", (ctx) =>
        runBrowserConnect(ctx, deps, opts),
      );
    });
}
