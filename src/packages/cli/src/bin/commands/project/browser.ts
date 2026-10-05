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
import { spawn } from "node:child_process";
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

// Run `curl` in the project over the managed ssh alias.  code is null when
// ssh could not be started; 127 means no curl in the project.
function probeProjectPort(
  alias: string,
  projectPort: number,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "ssh",
      [
        alias,
        `curl -sf --max-time 3 http://127.0.0.1:${projectPort}/json/version`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", () => resolve({ code: null, stdout }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

// Wait until the project port answers with *this* browser's DevTools id.
async function verifyProjectSeesBrowser({
  alias,
  projectPort,
  localPort,
}: {
  alias: string;
  projectPort: number;
  localPort: number;
}): Promise<"verified" | "skipped"> {
  const local = await fetch(`http://127.0.0.1:${localPort}/json/version`);
  const localId = devToolsBrowserId(await local.text());
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { code, stdout } = await probeProjectPort(alias, projectPort);
    if (code === 127) return "skipped"; // no curl in the project
    // 0: something answered; 22: it answered with an HTTP error, so it is
    // not a browser.  Anything else (e.g. 7, connection refused) is retried.
    if (code === 0 || code === 22) {
      const remoteId = devToolsBrowserId(stdout);
      if (localId && remoteId === localId) return "verified";
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
    runReflectSyncCli,
    listReflectForwards,
    parseCreatedForwardId,
    terminateReflectForwards,
  } = deps;
  const storage = parseStorage(opts.profileStorage);
  const projectPort = parsePort(opts.port);
  const sys = defaultLocalBrowserSystem();
  const executable = findChrome(opts.chrome, sys);
  const say = (line: string) => {
    if (!ctx.globals.json && ctx.globals.output !== "json") {
      console.error(line);
    }
  };

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
  let forwardId: number | null = null;
  let verification: "verified" | "skipped" = "skipped";
  let endedBy = "browser closed";
  try {
    profile = await createProfileDir(storage, sys);
    browser = await launchBrowser({
      executable,
      profileDir: profile.path,
      args: chromeLaunchArgs({
        profileDir: profile.path,
        url: opts.url,
        headless: opts.headless,
      }),
    });
    const created = await runReflectSyncCli(
      localToProjectForwardArgs({
        sshTarget: alias,
        projectPort,
        localPort: browser.port,
        name,
        compress: opts.compress,
      }),
    );
    forwardId = parseCreatedForwardId(`${created.stdout}\n${created.stderr}`);
    say(`Connecting the browser to project ${projectId}...`);
    const verified = await Promise.race([
      verifyProjectSeesBrowser({
        alias,
        projectPort,
        localPort: browser.port,
      }),
      browser.exited.then(() => "closed" as const),
    ]);
    if (verified === "closed") {
      throw new Error("the browser closed before the project reached it");
    }
    verification = verified;
    say(
      [
        `Browser ready: agents in the project can use http://127.0.0.1:${projectPort} (Chrome DevTools Protocol).`,
        verification === "skipped"
          ? "(Could not verify from the project: curl is not installed there.)"
          : null,
        storage === "memory"
          ? `Profile is in RAM (${profile.backing}) and is discarded on exit.`
          : `Profile is a temporary directory (${profile.path}), deleted on exit.`,
        "Close the browser or press Ctrl-C to end the session.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const signal = await Promise.race([
      browser.exited.then(() => null),
      stopped,
    ]);
    if (signal) endedBy = signal;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    const steps: Array<() => Promise<unknown>> = [
      () =>
        forwardId != null
          ? terminateReflectForwards([String(forwardId)])
          : Promise.resolve(),
      () => browser?.stop() ?? Promise.resolve(),
      () => profile?.cleanup() ?? Promise.resolve(),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        say(`cleanup: ${(err as Error)?.message ?? err}`);
      }
    }
  }
  say("Browser session ended; forward and profile removed.");
  return {
    project_id: projectId,
    project_port: projectPort,
    browser: executable,
    profile_storage: storage,
    profile_backing: profile?.backing ?? null,
    forward_name: name,
    verification,
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
      "launch a private local Chrome/Chromium whose DevTools endpoint is reachable at 127.0.0.1:<port> inside the project until the browser closes",
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
    .option("--url <url>", "page to open first", "about:blank")
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
