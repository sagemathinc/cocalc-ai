import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { Command } from "commander";
import { mapParallelLimit } from "@cocalc/util/async-utils";

import { buildCookieHeader } from "../../core/auth-cookies";
import { applyAuthProfile, loadAuthConfig } from "../../core/auth-config";

type DeployScope = "static" | "hub" | "bay" | "hosts" | "all";
type ReleaseBuildKind =
  | "bay-runtime"
  | "bay-hub"
  | "bay-static"
  | "project-host-software";

type RocketConfig = {
  clusters?: Record<string, RocketClusterConfig>;
};

type RocketClusterConfig = {
  hub_url?: string;
  api?: string;
  auth_profile?: string;
  ssh?: {
    remote?: string;
  };
  bay?: {
    id?: string;
    worker_count?: number | string;
    public_url?: string;
    require_clean_worktree?: boolean;
    retain_releases?: number | string;
  };
  deployment?: {
    script?: string;
    cli?: string;
    report_dir_base?: string;
  };
};

type DeployOptions = {
  cluster?: string;
  config?: string;
  scope?: string;
  staticOnly?: boolean;
  hubOnly?: boolean;
  skipHosts?: boolean;
  build?: boolean;
  bundle?: string;
  bundleUrl?: string;
  bundleSha256?: string;
  buildHostSoftware?: boolean;
  hostSoftwareBundle?: string;
  remote?: string;
  api?: string;
  publicUrl?: string;
  adminEmail?: string;
  adminAccountId?: string;
  cookie?: string;
  workerCount?: string;
  bayId?: string;
  retainReleases?: string;
  reportDir?: string;
  cli?: string;
  script?: string;
  restartHubWorkers?: boolean;
  restartSharedServices?: boolean;
  restartCloudflared?: boolean;
  bayService?: string;
  scaffoldOnly?: boolean;
  keepRemoteArtifacts?: boolean;
  cleanupLocalBundle?: boolean;
  allowDirty?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  wait?: boolean;
  channel?: string;
};

type CommandPlan = {
  scope: DeployScope;
  cluster?: string;
  api?: string;
  remote?: string;
  command: string;
  args: string[];
  redacted_args: string[];
  display_command: string;
};

type ReleaseBuildOptions = {
  kind?: string;
  outDir?: string;
  bundle?: string;
  tarball?: string;
  allowDirty?: boolean;
  dryRun?: boolean;
};

type HealthHostRoutesOptions = {
  cluster?: string;
  config?: string;
  api?: string;
  cookie?: string;
  cli?: string;
  workers?: string;
  hostLimit?: string;
  hostId?: string;
  siteFundedOnly?: boolean;
  allHosts?: boolean;
  probeConcurrency?: string;
  rpcTimeout?: string;
  requestTimeoutMs?: string;
};

type ReleaseBuildPlan = {
  kind: ReleaseBuildKind;
  command: string;
  args: string[];
  out_dir: string;
  artifact: string;
  manifest: string;
  display_command: string;
};

type ReleaseBuildSummary = ReleaseBuildPlan & {
  size_bytes: number;
  size: string;
  sha256: string;
  manifest_kind?: string;
  manifest_created?: string;
  git_commit?: string;
  git_branch?: string;
  git_dirty?: boolean;
};

type FrontdoorWorker = {
  id: number;
  healthy?: boolean;
  drained?: boolean;
};

type HostRouteProbe = {
  worker_id: number;
  host_id: string;
  host_name?: string;
  ok: boolean;
  ms: number;
  error?: string;
};

type HostRouteHealthResult = {
  ok: boolean;
  api: string;
  checked_at: string;
  workers: number[];
  hosts: Array<{ host_id: string; name?: string; status?: string }>;
  probes: HostRouteProbe[];
  timings_ms: {
    discover_workers: number;
    collect_affinity: number;
    list_hosts: number;
    probes: number;
    total: number;
  };
};

export type RocketCommandDeps = {
  runCommand: (
    command: string,
    args: string[],
    options?: {
      stdio?: "inherit" | "pipe";
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<number>;
  commandExists: (command: string) => boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  gitStatus?: (cwd: string) => string;
};

export function registerRocketCommand(
  program: Command,
  deps: RocketCommandDeps,
): Command {
  const rocket = program
    .command("rocket")
    .description("Rocket operator operations")
    .option("--config <path>", "rocket config path");

  const release = rocket
    .command("release")
    .description("Rocket release artifact operations");

  const health = rocket
    .command("health")
    .description("Rocket production health checks");

  release
    .command("build")
    .description("build a Rocket release artifact without deploying it")
    .requiredOption(
      "--kind <bay-runtime|bay-hub|bay-static|project-host-software>",
      "artifact kind to build",
    )
    .option("--out-dir <path>", "output directory for unpacked artifact")
    .option("--bundle <path>", "output tarball path")
    .option("--tarball <path>", "alias for --bundle")
    .option("--allow-dirty", "allow building from a dirty git worktree")
    .option("--dry-run", "print the resolved build command without running it")
    .action(async (opts: ReleaseBuildOptions, command: Command) => {
      const globals = command.optsWithGlobals() as Record<string, any>;
      const plan = buildReleaseBuildPlan({
        opts,
        deps,
      });

      if (opts.dryRun) {
        printReleaseBuildPlan(plan, globals);
        return;
      }
      maybeCheckCleanWorktree({
        build: true,
        allowDirty: opts.allowDirty === true,
        requireCleanWorktree: true,
        cwd: deps.cwd ?? process.cwd(),
        gitStatus: deps.gitStatus,
      });
      requireCommand(deps, "pnpm");
      const code = await deps.runCommand(plan.command, plan.args, {
        stdio: "inherit",
        env: deps.env ?? process.env,
      });
      if (code !== 0) {
        throw new Error(
          `rocket release build ${plan.kind} failed with exit status ${code}`,
        );
      }
      const summary = await summarizeReleaseBuild(plan);
      printReleaseBuildSummary(summary, globals);
    });

  health
    .command("host-routes [cluster]")
    .description(
      "verify every bay frontdoor hub worker can route to each online project-host API",
    )
    .option("--cluster <name>", "cluster name from rocket config")
    .option("--config <path>", "rocket config path")
    .option("--api <url>", "site API URL")
    .option("--cookie <header>", "cookie header for CLI auth")
    .option("--cli <path>", "local cocalc CLI path")
    .option(
      "--workers <ids>",
      "comma-separated frontdoor worker ids; default: discover from frontdoor health",
    )
    .option("--host-limit <n>", "maximum hosts to probe", "100")
    .option("--host-id <uuid>", "probe one explicit project host")
    .option(
      "--site-funded-only",
      "probe deterministic site-funded hosts instead of customer hosts",
    )
    .option(
      "--all-hosts",
      "probe all listed hosts instead of only online hosts",
    )
    .option("--probe-concurrency <n>", "maximum concurrent probes", "8")
    .option("--rpc-timeout <duration>", "per host CLI RPC timeout", "10s")
    .option("--request-timeout-ms <n>", "HTTP/CLI probe timeout in ms", "30000")
    .action(
      async (
        clusterArg: string | undefined,
        opts: HealthHostRoutesOptions,
        command: Command,
      ) => {
        const globals = command.optsWithGlobals() as Record<string, any>;
        const rocketOpts = command.parent?.parent?.opts() as
          | Record<string, any>
          | undefined;
        const result = await runHostRouteHealth({
          clusterArg,
          opts: {
            ...opts,
            config:
              opts.config ??
              stringOption(command.parent?.opts()?.config) ??
              stringOption(rocketOpts?.config),
            api: opts.api ?? stringOption(globals.api),
            cookie: opts.cookie ?? stringOption(globals.cookie),
          },
          globals,
          deps,
        });
        printHostRouteHealthResult(result, globals);
        if (!result.ok) {
          process.exitCode = 1;
        }
      },
    );

  rocket
    .command("deploy [cluster]")
    .description("deploy a Rocket bay, static assets, project hosts, or all")
    .option("--cluster <name>", "cluster name from rocket config")
    .option("--config <path>", "rocket config path")
    .option(
      "--scope <static|hub|bay|hosts|all>",
      "deployment scope; required unless using a compatibility alias",
    )
    .option("--static-only", "compatibility alias for --scope static")
    .option("--hub-only", "compatibility alias for --scope hub")
    .option("--skip-hosts", "compatibility alias for --scope bay")
    .option("--build", "build the required bundle before deploying")
    .option("--bundle <path>", "existing bay runtime, hub, or static bundle")
    .option(
      "--bundle-url <url>",
      "URL for the target VM to download the bay runtime, hub, or static bundle",
    )
    .option("--bundle-sha256 <sha256>", "expected SHA256 for --bundle-url")
    .option(
      "--build-host-software",
      "build project-host software bundle before host upgrades",
    )
    .option(
      "--host-software-bundle <path>",
      "existing project-host software bundle to stage before host upgrades",
    )
    .option("--remote <ssh-target>", "bay SSH target")
    .option("--api <url>", "site API URL")
    .option("--public-url <url>", "public bay URL for release env")
    .option("--admin-email <email>", "admin email for temporary deploy auth")
    .option(
      "--admin-account-id <uuid>",
      "admin account id for temporary deploy auth",
    )
    .option("--cookie <header>", "cookie header for deploy auth")
    .option("--worker-count <n>", "hub worker count override")
    .option("--bay-id <id>", "bay id")
    .option("--retain-releases <n>", "release retention")
    .option("--report-dir <dir>", "directory for deploy reports")
    .option("--cli <path>", "local cocalc CLI path")
    .option("--script <path>", "upgrade-bay-release.sh path")
    .option(
      "--restart-hub-workers",
      "restart hub workers one at a time for static deploys",
      false,
    )
    .option(
      "--restart-shared-services",
      "restart bay router/persist/peer-health during bay deploys",
      false,
    )
    .option(
      "--restart-cloudflared",
      "restart the bay Cloudflare tunnel during deploys",
      false,
    )
    .option(
      "--bay-service <conat-router|conat-persist|frontdoor|cloudflared|peer-health>",
      "restart exactly one bay service after staging a full bay runtime bundle",
    )
    .option(
      "--scaffold-only",
      "install bay scaffold and daemon-reload without rolling workers or restarting app services",
      false,
    )
    .option("--keep-remote-artifacts", "do not delete remote /tmp artifacts")
    .option("--cleanup-local-bundle", "remove local bundle after upload")
    .option("--allow-dirty", "allow building from a dirty git worktree")
    .option("--dry-run", "print the resolved deploy command without running it")
    .option("--yes", "confirm execution of the resolved deploy command")
    .option("--no-wait", "do not wait for hosts-only upgrades")
    .option(
      "--channel <stable|candidate|latest|staging>",
      "host software channel for hosts-only deploys",
    )
    .action(
      async (
        clusterArg: string | undefined,
        opts: DeployOptions,
        command: Command,
      ) => {
        const globals = command.optsWithGlobals() as Record<string, any>;
        const rocketOpts = command.parent?.opts() as Record<string, any>;
        const plan = buildDeployPlan({
          clusterArg,
          opts: mergeGlobalDeployOptions(
            {
              ...opts,
              config: opts.config ?? stringOption(rocketOpts.config),
            },
            globals,
          ),
          deps,
        });

        if (opts.dryRun) {
          printDeployPlan(plan, globals);
          return;
        }
        if (!opts.yes) {
          throw new Error(
            "refusing to run a mutating Rocket deploy without --yes; use --dry-run to inspect the command",
          );
        }
        const code = await deps.runCommand(plan.command, plan.args, {
          stdio: "inherit",
          env: deps.env ?? process.env,
        });
        if (code !== 0) {
          throw new Error(
            `rocket deploy ${plan.scope} failed with exit status ${code}`,
          );
        }
      },
    );

  return rocket;
}

function buildReleaseBuildPlan({
  opts,
  deps,
}: {
  opts: ReleaseBuildOptions;
  deps: RocketCommandDeps;
}): ReleaseBuildPlan {
  const kind = normalizeReleaseBuildKind(opts.kind);
  const cwd = deps.cwd ?? process.cwd();
  const srcRoot = findSrcRoot(cwd);
  const paths = releaseBuildPaths({
    srcRoot,
    kind,
    outDir: opts.outDir,
    bundle: opts.bundle ?? opts.tarball,
  });
  const scriptName =
    kind === "bay-runtime"
      ? "build:bay-bundle"
      : kind === "bay-hub"
        ? "build:bay-hub-bundle"
        : kind === "bay-static"
          ? "build:bay-static-bundle"
          : "build:project-host-software-bundle";
  const args = [
    "-C",
    join(srcRoot, "packages"),
    "--filter",
    "@cocalc/rocket",
    "run",
    scriptName,
  ];
  if (opts.outDir || opts.bundle || opts.tarball) {
    args.push(paths.out_dir, paths.artifact);
  }
  return {
    kind,
    command: "pnpm",
    args,
    out_dir: paths.out_dir,
    artifact: paths.artifact,
    manifest: paths.manifest,
    display_command: ["pnpm", ...args].map(shellQuote).join(" "),
  };
}

function mergeGlobalDeployOptions(
  opts: DeployOptions,
  globals: Record<string, any>,
): DeployOptions {
  return {
    ...opts,
    api: opts.api ?? stringOption(globals.api),
    cookie: opts.cookie ?? stringOption(globals.cookie),
  };
}

async function runHostRouteHealth({
  clusterArg,
  opts,
  globals,
  deps,
}: {
  clusterArg?: string;
  opts: HealthHostRoutesOptions;
  globals: Record<string, any>;
  deps: RocketCommandDeps;
}): Promise<HostRouteHealthResult> {
  const totalStarted = Date.now();
  const env = deps.env ?? process.env;
  const configPath = resolveConfigPath(opts.config, env);
  const config = configPath ? readRocketConfig(configPath) : {};
  const clusterName = resolveClusterName(clusterArg, opts.cluster, config);
  const cluster = clusterName ? config.clusters?.[clusterName] : undefined;
  if (clusterName && configPath && !cluster) {
    throw new Error(`cluster '${clusterName}' not found in ${configPath}`);
  }

  const cwd = deps.cwd ?? process.cwd();
  const srcRoot = findSrcRoot(cwd);
  const api =
    stringOption(opts.api) ??
    stringOption(cluster?.hub_url) ??
    stringOption(cluster?.api);
  if (!api) {
    throw new Error(
      "Rocket host route health requires --api or clusters.<name>.hub_url",
    );
  }
  const cliPath = expandPath(
    stringOption(opts.cli) ??
      cluster?.deployment?.cli ??
      join(srcRoot, "packages", "cli", "dist", "bin", "cocalc.js"),
  );
  if (!existsSync(cliPath)) {
    throw new Error(`cocalc CLI not found: ${cliPath}`);
  }

  const requestTimeoutMs =
    parsePositiveIntegerOption(opts.requestTimeoutMs, "--request-timeout-ms") ??
    30_000;
  const hostLimit =
    parsePositiveIntegerOption(opts.hostLimit, "--host-limit") ?? 100;
  const probeConcurrency =
    parsePositiveIntegerOption(opts.probeConcurrency, "--probe-concurrency") ??
    8;
  const authCookie = resolveAuthCookieForHealth({
    api,
    opts,
    globals,
    env,
  });
  const workersStarted = Date.now();
  const configuredWorkers = parseWorkerIds(opts.workers);
  const workers =
    configuredWorkers ??
    (await discoverFrontdoorWorkerIds({ api, requestTimeoutMs }));
  const discoverWorkersMs = Date.now() - workersStarted;
  const affinityStarted = Date.now();
  const affinityCookies = await collectFrontdoorAffinityCookies({
    api,
    workers,
    requestTimeoutMs,
  });
  const collectAffinityMs = Date.now() - affinityStarted;
  const hostsStarted = Date.now();
  const hosts = await listHostsForRouteHealth({
    cliPath,
    api,
    authCookie,
    hostLimit,
    hostId: stringOption(opts.hostId),
    siteFundedOnly: opts.siteFundedOnly === true,
    allHosts: opts.allHosts === true,
    requestTimeoutMs,
  });
  const listHostsMs = Date.now() - hostsStarted;
  const probesStarted = Date.now();
  const probes: HostRouteProbe[] = [];
  const probeTasks: Array<() => Promise<HostRouteProbe>> = [];
  for (const workerId of workers) {
    const affinityCookie = affinityCookies.get(workerId);
    if (!affinityCookie) {
      for (const host of hosts) {
        probes.push({
          worker_id: workerId,
          host_id: host.host_id,
          host_name: host.name,
          ok: false,
          ms: 0,
          error: "failed to obtain signed frontdoor affinity cookie",
        });
      }
      continue;
    }
    for (const host of hosts) {
      probeTasks.push(
        async () =>
          await runHostRouteProbe({
            cliPath,
            api,
            authCookie,
            affinityCookie,
            workerId,
            host,
            rpcTimeout: stringOption(opts.rpcTimeout) ?? "10s",
            requestTimeoutMs,
          }),
      );
    }
  }
  const resolvedProbes = [
    ...probes,
    ...(await mapParallelLimit(
      probeTasks,
      async (probe) => await probe(),
      probeConcurrency,
    )),
  ];
  const probesMs = Date.now() - probesStarted;
  return {
    ok: resolvedProbes.every((probe) => probe.ok),
    api,
    checked_at: new Date().toISOString(),
    workers,
    hosts,
    probes: resolvedProbes,
    timings_ms: {
      discover_workers: discoverWorkersMs,
      collect_affinity: collectAffinityMs,
      list_hosts: listHostsMs,
      probes: probesMs,
      total: Date.now() - totalStarted,
    },
  };
}

function resolveAuthCookieForHealth({
  api,
  opts,
  globals,
  env,
}: {
  api: string;
  opts: HealthHostRoutesOptions;
  globals: Record<string, any>;
  env: NodeJS.ProcessEnv;
}): string {
  const config = loadAuthConfig();
  const applied = applyAuthProfile(
    {
      profile: stringOption(globals.profile),
      api,
      cookie: stringOption(opts.cookie) ?? stringOption(globals.cookie),
      apiKey: stringOption(globals.apiKey),
      bearer: stringOption(globals.bearer),
      hubPassword: stringOption(globals.hubPassword),
      accountId: stringOption(globals.accountId),
      account_id: stringOption(globals.account_id),
      disableEnvAuthDefaults: globals.disableEnvAuthDefaults === true,
    },
    config,
    env,
  );
  const cookie = buildCookieHeader(api, applied.globals, {}, env);
  if (!cookie) {
    throw new Error(
      "Rocket host route health requires cookie-compatible CLI auth; run `cocalc --api <url> auth login` or pass --cookie",
    );
  }
  return cookie;
}

function parseWorkerIds(value: string | undefined): number[] | undefined {
  const text = stringOption(value);
  if (!text) return undefined;
  const ids = text.split(",").map((part) => Number.parseInt(part.trim(), 10));
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("--workers must be a comma-separated list of positive ids");
  }
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

async function discoverFrontdoorWorkerIds({
  api,
  requestTimeoutMs,
}: {
  api: string;
  requestTimeoutMs: number;
}): Promise<number[]> {
  let payload: any;
  try {
    payload = await requestJson({
      url: new URL("/_cocalc/frontdoor/healthz", api),
      requestTimeoutMs,
    });
  } catch (err) {
    throw new Error(
      `frontdoor health endpoint is unavailable at ${api}; this site may not be using the bay frontdoor yet, or pass --workers explicitly: ${(err as Error).message}`,
    );
  }
  const workers = Array.isArray(payload?.workers)
    ? (payload.workers as FrontdoorWorker[])
        .filter((worker) => worker.healthy !== false && worker.drained !== true)
        .map((worker) => worker.id)
    : [];
  if (workers.length === 0) {
    throw new Error("frontdoor health returned no healthy, undrained workers");
  }
  return workers.sort((a, b) => a - b);
}

async function collectFrontdoorAffinityCookies({
  api,
  workers,
  requestTimeoutMs,
}: {
  api: string;
  workers: number[];
  requestTimeoutMs: number;
}): Promise<Map<number, string>> {
  const wanted = new Set(workers);
  const cookies = new Map<number, string>();
  const maxAttempts = Math.max(12, workers.length * 8);
  for (
    let attempt = 0;
    attempt < maxAttempts && cookies.size < wanted.size;
    attempt++
  ) {
    const setCookies = await requestSetCookies({
      // Public pages and content-addressed assets intentionally omit affinity
      // cookies so shared caches cannot pin one visitor's worker assignment.
      // The mutable app shell is private and therefore exercises the same
      // affinity path used by an authenticated browser session.
      url: new URL(
        `/static/app.html?_cocalc_frontdoor_probe=${Date.now()}-${attempt}`,
        api,
      ),
      requestTimeoutMs,
    });
    const parsed = parseFrontdoorAffinityCookie(setCookies);
    if (parsed && wanted.has(parsed.workerId)) {
      cookies.set(parsed.workerId, parsed.cookie);
    }
  }
  return cookies;
}

function parseFrontdoorAffinityCookie(
  setCookies: string[],
): { workerId: number; cookie: string } | undefined {
  for (const header of setCookies) {
    const cookie = header.split(";", 1)[0]?.trim();
    const prefix = "cocalc_bay_frontdoor_worker=";
    if (!cookie?.startsWith(prefix)) {
      continue;
    }
    const value = cookie.slice(prefix.length);
    const workerId = Number.parseInt(value.split(".", 1)[0] ?? "", 10);
    if (Number.isInteger(workerId) && workerId > 0) {
      return { workerId, cookie };
    }
  }
  return undefined;
}

async function listHostsForRouteHealth({
  cliPath,
  api,
  authCookie,
  hostLimit,
  hostId,
  siteFundedOnly,
  allHosts,
  requestTimeoutMs,
}: {
  cliPath: string;
  api: string;
  authCookie: string;
  hostLimit: number;
  hostId?: string;
  siteFundedOnly: boolean;
  allHosts: boolean;
  requestTimeoutMs: number;
}): Promise<Array<{ host_id: string; name?: string; status?: string }>> {
  const invocation = cliInvocation(cliPath, [
    "--api",
    api,
    "--disable-env-auth-defaults",
    "--cookie",
    authCookie,
    "--output",
    "json",
    "host",
    "list",
    "--admin-view",
    "--route-health",
    "--limit",
    "10000",
  ]);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    timeout: requestTimeoutMs,
  });
  if (result.error) {
    throw new Error(`host list failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `host list failed: ${trimCommandOutput(result.stderr || result.stdout)}`,
    );
  }
  const rows = normalizeCliDataArray(result.stdout, "host list");
  const candidates = rows
    .map((row) => ({
      host_id: `${row.host_id ?? row.id ?? ""}`.trim(),
      name: stringOption(row.name),
      status: stringOption(row.status),
      funding_mode: stringOption(row.funding_mode),
    }))
    .filter(
      (row) =>
        row.host_id &&
        (allHosts || row.status === "online" || row.status === "running") &&
        (!hostId || row.host_id === hostId) &&
        (!siteFundedOnly || row.funding_mode === "site-funded"),
    )
    .sort((left, right) => {
      const byName = (left.name ?? "").localeCompare(right.name ?? "");
      return byName || left.host_id.localeCompare(right.host_id);
    })
    .slice(0, hostLimit)
    .map(({ funding_mode: _fundingMode, ...host }) => host);
  if (candidates.length === 0) {
    const target = hostId
      ? `host ${hostId}`
      : siteFundedOnly
        ? "an online site-funded host"
        : "an eligible host";
    throw new Error(`host list did not return ${target}`);
  }
  return candidates;
}

async function runHostRouteProbe({
  cliPath,
  api,
  authCookie,
  affinityCookie,
  workerId,
  host,
  rpcTimeout,
  requestTimeoutMs,
}: {
  cliPath: string;
  api: string;
  authCookie: string;
  affinityCookie: string;
  workerId: number;
  host: { host_id: string; name?: string };
  rpcTimeout: string;
  requestTimeoutMs: number;
}): Promise<HostRouteProbe> {
  const started = Date.now();
  const cookie = appendCookieHeader(authCookie, affinityCookie);
  const invocation = cliInvocation(cliPath, [
    "--api",
    api,
    "--disable-env-auth-defaults",
    "--cookie",
    cookie,
    "--rpc-timeout",
    rpcTimeout,
    "--timeout",
    `${Math.max(1, Math.ceil(requestTimeoutMs / 1000))}s`,
    "--output",
    "json",
    "host",
    "get",
    "--route-health",
    host.host_id,
  ]);
  const result = await execFileResult(
    invocation.command,
    invocation.args,
    requestTimeoutMs + 2_000,
  );
  const ms = Date.now() - started;
  const output = trimCommandOutput(result.stderr || result.stdout);
  if (result.error) {
    return {
      worker_id: workerId,
      host_id: host.host_id,
      host_name: host.name,
      ok: false,
      ms,
      error: result.error.message,
    };
  }
  if (result.status !== 0) {
    return {
      worker_id: workerId,
      host_id: host.host_id,
      host_name: host.name,
      ok: false,
      ms,
      error: output || `exit status ${result.status}`,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed?.ok === false) {
      return {
        worker_id: workerId,
        host_id: host.host_id,
        host_name: host.name,
        ok: false,
        ms,
        error:
          `${parsed?.error?.message ?? parsed?.error ?? "host get failed"}`.trim(),
      };
    }
  } catch {
    // The exit status is authoritative; tolerate non-JSON wrappers from older CLIs.
  }
  return {
    worker_id: workerId,
    host_id: host.host_id,
    host_name: host.name,
    ok: true,
    ms,
  };
}

function execFileResult(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}> {
  return new Promise((resolveResult) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const errorCode = (error as { code?: unknown } | null)?.code;
        const status =
          typeof errorCode === "number" ? errorCode : error ? null : 0;
        resolveResult({
          status,
          stdout,
          stderr,
          error: error ?? undefined,
        });
      },
    );
  });
}

function appendCookieHeader(base: string, extra: string): string {
  const parts = [base.trim(), extra.trim()].filter(Boolean);
  return parts.join("; ");
}

function normalizeCliDataArray(stdout: string, label: string): any[] {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `${label} returned invalid JSON: ${(err as Error).message}`,
    );
  }
  if (parsed?.ok === false) {
    throw new Error(
      `${label} failed: ${parsed?.error?.message ?? "unknown error"}`,
    );
  }
  const data = parsed?.data ?? parsed;
  if (!Array.isArray(data)) {
    throw new Error(`${label} did not return an array`);
  }
  return data;
}

function cliInvocation(
  cliPath: string,
  args: string[],
): { command: string; args: string[] } {
  return extname(cliPath).toLowerCase() === ".js"
    ? { command: process.execPath, args: [cliPath, ...args] }
    : { command: cliPath, args };
}

function trimCommandOutput(output?: string | null): string {
  return `${output ?? ""}`.trim().split(/\r?\n/).slice(-8).join("\n");
}

function requestJson({
  url,
  requestTimeoutMs,
}: {
  url: URL;
  requestTimeoutMs: number;
}): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = requestModule(url).request(
      url,
      { method: "GET", timeout: requestTimeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`invalid JSON: ${(err as Error).message}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end();
  });
}

function requestSetCookies({
  url,
  requestTimeoutMs,
}: {
  url: URL;
  requestTimeoutMs: number;
}): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = requestModule(url).request(
      url,
      { method: "HEAD", timeout: requestTimeoutMs },
      (res) => {
        res.resume();
        const cookies = res.headers["set-cookie"] ?? [];
        resolve(Array.isArray(cookies) ? cookies : [cookies]);
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end();
  });
}

function requestModule(url: URL) {
  if (url.protocol === "http:") return http;
  if (url.protocol === "https:") return https;
  throw new Error(`unsupported URL protocol: ${url.protocol}`);
}

function buildDeployPlan({
  clusterArg,
  opts,
  deps,
}: {
  clusterArg?: string;
  opts: DeployOptions;
  deps: RocketCommandDeps;
}): CommandPlan {
  const env = deps.env ?? process.env;
  const configPath = resolveConfigPath(opts.config, env);
  const config = configPath ? readRocketConfig(configPath) : {};
  const clusterName = resolveClusterName(clusterArg, opts.cluster, config);
  const cluster = clusterName ? config.clusters?.[clusterName] : undefined;
  if (clusterName && configPath && !cluster) {
    throw new Error(`cluster '${clusterName}' not found in ${configPath}`);
  }
  const scope = resolveScope(opts);
  const cwd = deps.cwd ?? process.cwd();
  const srcRoot = findSrcRoot(cwd);
  const scriptPath = expandPath(
    stringOption(opts.script) ??
      cluster?.deployment?.script ??
      join(srcRoot, "scripts", "bay-systemd", "upgrade-bay-release.sh"),
  );
  const cliPath = expandPath(
    stringOption(opts.cli) ??
      cluster?.deployment?.cli ??
      join(srcRoot, "packages", "cli", "dist", "bin", "cocalc.js"),
  );
  const api =
    stringOption(opts.api) ??
    stringOption(cluster?.hub_url) ??
    stringOption(cluster?.api);
  const remote =
    stringOption(opts.remote) ?? stringOption(cluster?.ssh?.remote);
  const publicUrl =
    stringOption(opts.publicUrl) ??
    stringOption(cluster?.bay?.public_url) ??
    api;
  const workerCount = parsePositiveIntegerOption(
    opts.workerCount ?? cluster?.bay?.worker_count,
    "--worker-count",
  );
  const retainReleases = parsePositiveIntegerOption(
    opts.retainReleases ?? cluster?.bay?.retain_releases,
    "--retain-releases",
  );
  const bayId =
    stringOption(opts.bayId) ?? stringOption(cluster?.bay?.id) ?? "bay-0";
  const reportDir =
    stringOption(opts.reportDir) ??
    makeDefaultReportDir(cluster?.deployment?.report_dir_base, scope);

  if (scope === "hosts") {
    return buildHostsDeployPlan({
      clusterName,
      api,
      cliPath,
      opts,
    });
  }

  if (!remote) {
    throw new Error(
      "Rocket bay deploy requires --remote or clusters.<name>.ssh.remote",
    );
  }
  if (!api) {
    throw new Error(
      "Rocket bay deploy requires --api or clusters.<name>.hub_url",
    );
  }
  if (!opts.build && !opts.bundle && !opts.bundleUrl) {
    throw new Error(
      "Rocket bay deploy requires --build, --bundle <path>, or --bundle-url <url>",
    );
  }
  if (
    [opts.build === true, !!opts.bundle, !!opts.bundleUrl].filter(Boolean)
      .length > 1
  ) {
    throw new Error(
      "use only one of --build, --bundle <path>, or --bundle-url <url>",
    );
  }
  if (opts.bundleSha256 && !opts.bundleUrl) {
    throw new Error("--bundle-sha256 requires --bundle-url");
  }
  if (opts.buildHostSoftware && opts.hostSoftwareBundle) {
    throw new Error(
      "use either --build-host-software or --host-software-bundle <path>, not both",
    );
  }
  if (
    scope === "all" &&
    !opts.cookie &&
    !opts.adminEmail &&
    !opts.adminAccountId
  ) {
    throw new Error(
      "Rocket --scope all requires --admin-email, --admin-account-id, or --cookie for project host upgrade auth",
    );
  }
  maybeCheckCleanWorktree({
    build: opts.build === true,
    allowDirty: opts.allowDirty === true,
    requireCleanWorktree: cluster?.bay?.require_clean_worktree,
    cwd,
    gitStatus: deps.gitStatus,
  });
  requireCommand(deps, "bash");
  if (!existsSync(scriptPath)) {
    throw new Error(`upgrade script not found: ${scriptPath}`);
  }
  const args = [scriptPath, "--remote", remote, "--api", api];
  if (opts.build) {
    args.push("--build-bundle");
  } else if (opts.bundle) {
    args.push("--bundle", expandPath(opts.bundle));
  } else if (opts.bundleUrl) {
    args.push("--bundle-url", opts.bundleUrl);
    if (opts.bundleSha256) {
      args.push("--bundle-sha256", opts.bundleSha256);
    }
  }
  if (opts.buildHostSoftware || (scope === "all" && opts.build)) {
    args.push("--build-host-software-bundle");
  } else if (opts.hostSoftwareBundle) {
    args.push("--host-software-bundle", expandPath(opts.hostSoftwareBundle));
  }
  args.push("--public-url", publicUrl ?? api);
  args.push("--bay-id", bayId);
  if (workerCount) {
    args.push("--worker-count", `${workerCount}`);
  }
  if (retainReleases) {
    args.push("--retain-releases", `${retainReleases}`);
  }
  if (reportDir) {
    args.push("--report-dir", expandPath(reportDir));
  }
  if (cliPath) {
    args.push("--cli", cliPath);
  }
  if (scope === "static") {
    args.push("--static-only");
    if (opts.restartHubWorkers) {
      args.push("--restart-hub-workers");
    }
  }
  if (scope === "hub") {
    args.push("--hub-only");
  }
  if (scope === "bay") {
    args.push("--skip-host-upgrade");
  }
  if (opts.cookie) {
    args.push("--cookie", opts.cookie);
  }
  if (opts.adminEmail) {
    args.push("--admin-email", opts.adminEmail);
  }
  if (opts.adminAccountId) {
    args.push("--admin-account-id", opts.adminAccountId);
  }
  if (opts.keepRemoteArtifacts) {
    args.push("--keep-remote-artifacts");
  }
  if (opts.restartSharedServices) {
    args.push("--restart-shared-services");
  }
  if (opts.restartCloudflared) {
    args.push("--restart-cloudflared");
  }
  if (opts.bayService) {
    args.push("--restart-bay-service", opts.bayService);
  }
  if (opts.scaffoldOnly) {
    args.push("--scaffold-only");
  }
  if (opts.cleanupLocalBundle) {
    args.push("--cleanup-local-bundle");
  }
  return makePlan({
    scope,
    cluster: clusterName,
    api,
    remote,
    command: "bash",
    args,
  });
}

function buildHostsDeployPlan({
  clusterName,
  api,
  cliPath,
  opts,
}: {
  clusterName?: string;
  api?: string;
  cliPath: string;
  opts: DeployOptions;
}): CommandPlan {
  if (!api) {
    throw new Error(
      "Rocket hosts deploy requires --api or clusters.<name>.hub_url",
    );
  }
  if (!existsSync(cliPath)) {
    throw new Error(`cocalc CLI not found: ${cliPath}`);
  }
  if (opts.adminEmail || opts.adminAccountId) {
    throw new Error(
      "hosts-only deploy uses normal CLI auth; use --cookie or run `cocalc --api <url> auth login` first",
    );
  }
  const channel = normalizeHostChannel(opts.channel);
  const args = [
    "--api",
    api,
    "host",
    "upgrade",
    "--hub-source",
    "--all-online",
    "--artifact",
    "project-host",
    "project",
    "tools",
    "bootstrap-environment",
    "--align-runtime-stack",
    "--channel",
    channel,
  ];
  if (opts.cookie) {
    args.splice(2, 0, "--cookie", opts.cookie);
  }
  if (opts.wait !== false) {
    args.push("--wait");
  }
  return makePlan({
    scope: "hosts",
    cluster: clusterName,
    api,
    command: cliPath,
    args,
  });
}

function resolveScope(opts: DeployOptions): DeployScope {
  const aliases: DeployScope[] = [];
  if (opts.staticOnly) aliases.push("static");
  if (opts.hubOnly) aliases.push("hub");
  if (opts.skipHosts) aliases.push("bay");
  const explicit = stringOption(opts.scope)?.toLowerCase();
  if (explicit && !isDeployScope(explicit)) {
    throw new Error("--scope must be one of: static, hub, bay, hosts, all");
  }
  const explicitScope = explicit as DeployScope | undefined;
  if (aliases.length > 0) {
    const uniqueAliases = Array.from(new Set(aliases));
    if (uniqueAliases.length > 1) {
      throw new Error("conflicting deploy scope aliases were provided");
    }
    if (explicitScope && explicitScope !== uniqueAliases[0]) {
      throw new Error(
        `conflicting deploy scope: --scope ${explicitScope} with alias for ${uniqueAliases[0]}`,
      );
    }
    return uniqueAliases[0];
  }
  if (!explicitScope) {
    throw new Error(
      "Rocket deploy requires explicit --scope static|hub|bay|hosts|all",
    );
  }
  return explicitScope;
}

function isDeployScope(value: string): value is DeployScope {
  return (
    value === "static" ||
    value === "hub" ||
    value === "bay" ||
    value === "hosts" ||
    value === "all"
  );
}

function resolveConfigPath(
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const configured =
    stringOption(explicitPath) ?? stringOption(env.COCALC_ROCKET_CONFIG);
  if (configured) {
    return expandPath(configured);
  }
  const candidates = [
    "~/.config/cocalc/rocket/config.yaml",
    "~/.config/cocalc/rocket/config.yml",
    "~/.config/cocalc/rocket/config.json",
  ];
  return candidates.map(expandPath).find((path) => existsSync(path));
}

function readRocketConfig(path: string): RocketConfig {
  const realPath = realpathSync(path);
  checkReadableConfigFile(realPath);
  const text = readFileSync(realPath, "utf8");
  if (extname(realPath).toLowerCase() === ".json") {
    return JSON.parse(text) as RocketConfig;
  }
  return parseSimpleYaml(text) as RocketConfig;
}

function checkReadableConfigFile(path: string) {
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error(`rocket config is not a file: ${path}`);
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o002) !== 0) {
    throw new Error(
      `rocket config must not be world-writable: ${path}; run chmod o-w ${shellQuote(path)}`,
    );
  }
  const parent = statSync(dirname(path));
  if ((parent.mode & 0o002) !== 0) {
    throw new Error(
      `rocket config directory must not be world-writable: ${dirname(path)}`,
    );
  }
}

function resolveClusterName(
  clusterArg: string | undefined,
  clusterOption: string | undefined,
  config: RocketConfig,
): string | undefined {
  const positional = stringOption(clusterArg);
  const option = stringOption(clusterOption);
  if (positional && option && positional !== option) {
    throw new Error(
      `conflicting cluster names: positional '${positional}' and --cluster '${option}'`,
    );
  }
  if (option ?? positional) {
    return option ?? positional;
  }
  const clusters = Object.keys(config.clusters ?? {});
  if (clusters.length === 1) {
    return clusters[0];
  }
  return undefined;
}

function parseSimpleYaml(text: string): Record<string, any> {
  const root: Record<string, any> = {};
  const stack: Array<{ indent: number; value: Record<string, any> }> = [
    { indent: -1, value: root },
  ];
  for (const rawLine of text.split(/\r?\n/)) {
    const lineWithoutComment = rawLine.replace(/\s+#.*$/, "");
    if (
      !lineWithoutComment.trim() ||
      lineWithoutComment.trim().startsWith("#")
    ) {
      continue;
    }
    const match = lineWithoutComment.match(
      /^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*))?$/,
    );
    if (!match) {
      throw new Error(`unsupported rocket yaml line: ${rawLine}`);
    }
    const indent = match[1].length;
    const key = match[2];
    const rawValue = match[3] ?? "";
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].value;
    if (!rawValue.trim()) {
      const child: Record<string, any> = {};
      parent[key] = child;
      stack.push({ indent, value: child });
      continue;
    }
    parent[key] = parseYamlScalar(rawValue.trim());
  }
  return root;
}

function parseYamlScalar(value: string): any {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return value;
}

function findSrcRoot(cwd: string): string {
  for (const start of [cwd, process.cwd(), __dirname]) {
    let dir = resolve(start);
    while (true) {
      const direct = join(
        dir,
        "scripts",
        "bay-systemd",
        "upgrade-bay-release.sh",
      );
      if (existsSync(direct)) {
        return dir;
      }
      const nested = join(
        dir,
        "src",
        "scripts",
        "bay-systemd",
        "upgrade-bay-release.sh",
      );
      if (existsSync(nested)) {
        return join(dir, "src");
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  throw new Error(
    "unable to locate src/scripts/bay-systemd/upgrade-bay-release.sh",
  );
}

function maybeCheckCleanWorktree({
  build,
  allowDirty,
  requireCleanWorktree,
  cwd,
  gitStatus,
}: {
  build: boolean;
  allowDirty: boolean;
  requireCleanWorktree?: boolean;
  cwd: string;
  gitStatus?: (cwd: string) => string;
}) {
  if (!build || allowDirty || requireCleanWorktree === false) {
    return;
  }
  const status = gitStatus ? gitStatus(cwd) : defaultGitStatus(cwd);
  if (status.trim()) {
    throw new Error(
      "refusing to build a Rocket deploy from a dirty git worktree; commit/stash changes or pass --allow-dirty",
    );
  }
}

function defaultGitStatus(cwd: string): string {
  const result = spawnSync("git", ["status", "--short"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git status failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function normalizeReleaseBuildKind(kind: string | undefined): ReleaseBuildKind {
  const value = stringOption(kind)?.toLowerCase();
  if (value === "bay-runtime" || value === "runtime") {
    return "bay-runtime";
  }
  if (value === "bay-hub" || value === "hub") {
    return "bay-hub";
  }
  if (value === "bay-static" || value === "static") {
    return "bay-static";
  }
  if (
    value === "project-host-software" ||
    value === "host-software" ||
    value === "hosts"
  ) {
    return "project-host-software";
  }
  throw new Error(
    "--kind must be one of: bay-runtime, bay-hub, bay-static, project-host-software",
  );
}

function releaseBuildPaths({
  srcRoot,
  kind,
  outDir,
  bundle,
}: {
  srcRoot: string;
  kind: ReleaseBuildKind;
  outDir?: string;
  bundle?: string;
}) {
  const buildRoot = join(srcRoot, "packages", "rocket", "build");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const defaultOutDir = join(
    buildRoot,
    kind === "bay-runtime"
      ? "bay-runtime"
      : kind === "bay-hub"
        ? "bay-hub"
        : kind === "bay-static"
          ? "bay-static"
          : "project-host-software",
  );
  const defaultArtifact = join(
    buildRoot,
    kind === "project-host-software"
      ? `cocalc-project-host-software-linux-${arch}.tar.xz`
      : kind === "bay-hub"
        ? `cocalc-bay-hub-linux-${arch}.tar.xz`
        : `cocalc-${kind}-linux-${arch}.tar.xz`,
  );
  const resolvedOutDir = expandPath(outDir ?? defaultOutDir);
  const resolvedArtifact = expandPath(
    bundle ??
      (outDir
        ? join(
            dirname(resolvedOutDir),
            kind === "project-host-software"
              ? `cocalc-project-host-software-linux-${arch}.tar.xz`
              : kind === "bay-hub"
                ? `cocalc-bay-hub-linux-${arch}.tar.xz`
                : `cocalc-${kind}-linux-${arch}.tar.xz`,
          )
        : defaultArtifact),
  );
  const manifest = join(
    resolvedOutDir,
    kind === "bay-runtime"
      ? "bay-runtime-manifest.json"
      : kind === "bay-hub"
        ? "bay-hub-manifest.json"
        : kind === "bay-static"
          ? "bay-static-manifest.json"
          : "project-host-software-manifest.json",
  );
  return {
    out_dir: resolvedOutDir,
    artifact: resolvedArtifact,
    manifest,
  };
}

async function summarizeReleaseBuild(
  plan: ReleaseBuildPlan,
): Promise<ReleaseBuildSummary> {
  if (!existsSync(plan.artifact)) {
    throw new Error(`build did not produce artifact: ${plan.artifact}`);
  }
  const stat = statSync(plan.artifact);
  const manifest = readReleaseManifest(plan.manifest);
  return {
    ...plan,
    size_bytes: stat.size,
    size: formatBytes(stat.size),
    sha256: await sha256File(plan.artifact),
    manifest_kind: stringOption(manifest?.kind),
    manifest_created: stringOption(manifest?.created),
    git_commit: stringOption(manifest?.git?.commit),
    git_branch: stringOption(manifest?.git?.branch),
    git_dirty:
      typeof manifest?.git?.dirty === "boolean"
        ? manifest.git.dirty
        : undefined,
  };
}

function readReleaseManifest(path: string): Record<string, any> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    return undefined;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function normalizeHostChannel(channel: string | undefined): string {
  const value = stringOption(channel)?.toLowerCase() ?? "latest";
  if (value === "stable" || value === "latest") {
    return "latest";
  }
  if (value === "candidate" || value === "staging") {
    return "staging";
  }
  throw new Error(
    "--channel must be one of: stable, candidate, latest, staging",
  );
}

function makeDefaultReportDir(
  reportDirBase: string | undefined,
  scope: DeployScope,
): string | undefined {
  const base = stringOption(reportDirBase);
  if (!base) {
    return undefined;
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "Z");
  return join(expandPath(base), `rocket-${scope}-${stamp}`);
}

function makePlan({
  scope,
  cluster,
  api,
  remote,
  command,
  args,
}: {
  scope: DeployScope;
  cluster?: string;
  api?: string;
  remote?: string;
  command: string;
  args: string[];
}): CommandPlan {
  const redactedArgs = redactArgs(args);
  return {
    scope,
    cluster,
    api,
    remote,
    command,
    args,
    redacted_args: redactedArgs,
    display_command: [command, ...redactedArgs].map(shellQuote).join(" "),
  };
}

function redactArgs(args: string[]): string[] {
  const redacted: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    redacted.push(arg);
    if (arg === "--cookie" && i + 1 < args.length) {
      redacted.push("<redacted>");
      i += 1;
      continue;
    }
    if (arg.startsWith("--cookie=")) {
      redacted[redacted.length - 1] = "--cookie=<redacted>";
    }
  }
  return redacted;
}

function printHostRouteHealthResult(
  result: HostRouteHealthResult,
  globals: Record<string, any>,
) {
  if (globals.json || globals.output === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log("Rocket host route health");
  console.log(`api: ${result.api}`);
  console.log(`workers: ${result.workers.join(", ") || "(none)"}`);
  console.log(`hosts: ${result.hosts.length}`);
  console.log(`ok: ${result.ok ? "yes" : "no"}`);
  console.log(
    `timings: workers=${result.timings_ms.discover_workers}ms affinity=${result.timings_ms.collect_affinity}ms hosts=${result.timings_ms.list_hosts}ms probes=${result.timings_ms.probes}ms total=${result.timings_ms.total}ms`,
  );
  console.log("");
  for (const probe of result.probes) {
    const host = probe.host_name
      ? `${probe.host_name} (${probe.host_id})`
      : probe.host_id;
    const status = probe.ok ? "ok" : "FAIL";
    console.log(
      `worker ${probe.worker_id} -> ${host}: ${status} ${probe.ms}ms${
        probe.error ? ` - ${probe.error}` : ""
      }`,
    );
  }
}

function printDeployPlan(plan: CommandPlan, globals: Record<string, any>) {
  if (globals.json || globals.output === "json") {
    const { args: _args, ...safePlan } = plan;
    console.log(
      JSON.stringify({ ok: true, dry_run: true, plan: safePlan }, null, 2),
    );
    return;
  }
  console.log("Rocket deploy dry run");
  if (plan.cluster) console.log(`cluster: ${plan.cluster}`);
  console.log(`scope: ${plan.scope}`);
  if (plan.api) console.log(`api: ${plan.api}`);
  if (plan.remote) console.log(`remote: ${plan.remote}`);
  console.log("");
  console.log(plan.display_command);
}

function printReleaseBuildPlan(
  plan: ReleaseBuildPlan,
  globals: Record<string, any>,
) {
  if (globals.json || globals.output === "json") {
    console.log(JSON.stringify({ ok: true, dry_run: true, plan }, null, 2));
    return;
  }
  console.log("Rocket release build dry run");
  console.log(`kind: ${plan.kind}`);
  console.log(`artifact: ${plan.artifact}`);
  console.log(`out_dir: ${plan.out_dir}`);
  console.log(`manifest: ${plan.manifest}`);
  console.log("");
  console.log(plan.display_command);
}

function printReleaseBuildSummary(
  summary: ReleaseBuildSummary,
  globals: Record<string, any>,
) {
  if (globals.json || globals.output === "json") {
    console.log(JSON.stringify({ ok: true, artifact: summary }, null, 2));
    return;
  }
  console.log("Rocket release build complete");
  console.log(`kind: ${summary.kind}`);
  console.log(`artifact: ${summary.artifact}`);
  console.log(`size: ${summary.size} (${summary.size_bytes} bytes)`);
  console.log(`sha256: ${summary.sha256}`);
  console.log(`out_dir: ${summary.out_dir}`);
  console.log(`manifest: ${summary.manifest}`);
  if (summary.git_commit) {
    console.log(
      `git: ${summary.git_commit}${summary.git_branch ? ` (${summary.git_branch})` : ""}${summary.git_dirty ? " dirty" : ""}`,
    );
  }
  console.log("");
  if (summary.kind === "project-host-software") {
    console.log(
      `Stage this exact artifact during a full deploy with: cocalc rocket deploy --scope all --host-software-bundle ${shellQuote(summary.artifact)} ...`,
    );
  } else {
    console.log(
      `Deploy this exact artifact with: cocalc rocket deploy --scope ${
        summary.kind === "bay-static"
          ? "static"
          : summary.kind === "bay-hub"
            ? "hub"
            : "bay"
      } --bundle ${shellQuote(summary.artifact)} ...`,
    );
  }
}

function requireCommand(deps: RocketCommandDeps, command: string) {
  if (!deps.commandExists(command)) {
    throw new Error(`missing required command: ${command}`);
  }
}

function parsePositiveIntegerOption(
  value: string | number | undefined,
  name: string,
): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(`${value}`, 10);
  if (
    !Number.isFinite(parsed) ||
    `${parsed}` !== `${value}`.trim() ||
    parsed <= 0
  ) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function stringOption(value: unknown): string | undefined {
  const text = `${value ?? ""}`.trim();
  return text || undefined;
}

function expandPath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith(`~${sep}`)) {
    return join(homedir(), path.slice(2));
  }
  return isAbsolute(path) ? path : resolve(path);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export const __test__ = {
  cliInvocation,
  trimCommandOutput,
};
