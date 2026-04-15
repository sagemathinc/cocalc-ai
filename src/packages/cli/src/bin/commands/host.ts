import { spawnSync } from "node:child_process";
import { Command } from "commander";

type HostRuntimeLogRow = any;
type HostSoftwareVersionRow = any;
type HostRow = any;
type HostSshAuthorizedKeysRow = any;
type HostMachine = any;
type HostSoftwareChannel = any;

export type HostCommandDeps = {
  withContext: any;
  listHosts: any;
  resolveHost: any;
  normalizeHostProviderValue: any;
  summarizeHostCatalogEntries: any;
  emitProjectFileCatHumanContent: any;
  parseHostSoftwareArtifactsOption: any;
  parseHostSoftwareChannelsOption: any;
  waitForLro: any;
  ensureSyncKeyPair: any;
  resolveHostSshEndpoint: any;
  expandUserPath: any;
  parseHostMachineJson: any;
  parseOptionalPositiveInteger: any;
  inferRegionFromZone: any;
  HOST_CREATE_DISK_TYPES: any;
  HOST_CREATE_STORAGE_MODES: any;
  waitForHostCreateReady: any;
  resolveProject: any;
};

function formatHostCreateProgressLine(update: {
  host: { id: string };
  status: string;
  hasHeartbeat: boolean;
  bootstrapStatus?: string;
  bootstrapMessage?: string;
}): string {
  const parts = [
    `host ${update.host.id}`,
    `status=${update.status || "unknown"}`,
    `heartbeat=${update.hasHeartbeat ? "ready" : "pending"}`,
  ];
  if (update.bootstrapStatus) {
    parts.push(`bootstrap=${update.bootstrapStatus}`);
  }
  let line = parts.join(" ");
  if (update.bootstrapMessage) {
    line += `: ${update.bootstrapMessage}`;
  }
  return line;
}

function formatBootstrapTimeoutDetail(host: {
  bootstrap?: {
    status?: string | null;
    message?: string | null;
  } | null;
}): string {
  const bootstrapStatus = `${host.bootstrap?.status ?? ""}`.trim();
  const bootstrapMessage = `${host.bootstrap?.message ?? ""}`.trim();
  if (!bootstrapStatus && !bootstrapMessage) {
    return "";
  }
  return ` bootstrap=${bootstrapStatus || "unknown"}${bootstrapMessage ? ` bootstrap_message=${JSON.stringify(bootstrapMessage)}` : ""}`;
}

function createHostProgressReporter(ctx: {
  globals: { json?: boolean; output?: string };
}) {
  if (ctx.globals.json || ctx.globals.output === "json") {
    return undefined;
  }
  let lastProgressLine = "";
  return (update: Parameters<typeof formatHostCreateProgressLine>[0]) => {
    const line = formatHostCreateProgressLine(update);
    if (line === lastProgressLine) return;
    lastProgressLine = line;
    process.stderr.write(`${line}\n`);
  };
}

const HOST_ONLINE_WINDOW_MS = 2 * 60 * 1000;

function isHostOnlineForUpgrade(host: {
  status?: string | null;
  last_seen?: string | null;
}): boolean {
  const status = `${host.status ?? ""}`.trim().toLowerCase();
  if (status !== "running" && status !== "active") {
    return false;
  }
  const lastSeen = `${host.last_seen ?? ""}`.trim();
  if (!lastSeen) return false;
  const ts = Date.parse(lastSeen);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= HOST_ONLINE_WINDOW_MS;
}

function parseMetricsWindowMinutes(window?: string): number {
  const raw = `${window ?? "1h"}`.trim().toLowerCase();
  if (!raw) return 60;
  const match = /^([0-9]+)(m|h|d)?$/u.exec(raw);
  if (!match) {
    throw new Error("--window must look like 30m, 1h, or 7d");
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("--window must be positive");
  }
  const unit = match[2] ?? "m";
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  return value * 24 * 60;
}

function parseManagedComponentKindsOption(values?: string[]) {
  const allowed = new Set([
    "project-host",
    "conat-router",
    "conat-persist",
    "acp-worker",
  ]);
  const normalized = (values ?? [])
    .flatMap((value) => `${value ?? ""}`.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (!normalized.length) {
    throw new Error(
      "specify at least one --component (project-host, conat-router, conat-persist, acp-worker)",
    );
  }
  const invalid = normalized.filter((value) => !allowed.has(value));
  if (invalid.length) {
    throw new Error(
      `invalid component(s): ${invalid.join(", ")}; expected one of project-host, conat-router, conat-persist, acp-worker`,
    );
  }
  return [...new Set(normalized)];
}

function parseRuntimeDeploymentPolicy(value?: string) {
  const policy = `${value ?? ""}`.trim();
  if (!policy) return undefined;
  if (policy === "restart_now" || policy === "drain_then_replace") {
    return policy;
  }
  throw new Error(
    "invalid --policy; expected restart_now or drain_then_replace",
  );
}

function parseRuntimeDeploymentTarget(opts: {
  component?: string;
  artifact?: string;
}) {
  const component = `${opts.component ?? ""}`.trim();
  const artifact = `${opts.artifact ?? ""}`.trim();
  if (!!component === !!artifact) {
    throw new Error("specify exactly one of --component or --artifact");
  }
  if (component) {
    const [parsed] = parseManagedComponentKindsOption([component]);
    return {
      target_type: "component" as const,
      target: parsed,
    };
  }
  const allowed = new Set([
    "project-host",
    "project-bundle",
    "tools",
    "bootstrap-environment",
  ]);
  if (!allowed.has(artifact)) {
    throw new Error(
      "invalid --artifact; expected project-host, project-bundle, tools, or bootstrap-environment",
    );
  }
  return {
    target_type: "artifact" as const,
    target: artifact,
  };
}

export function registerHostCommand(
  program: Command,
  deps: HostCommandDeps,
): Command {
  const {
    withContext,
    listHosts,
    resolveHost,
    normalizeHostProviderValue,
    summarizeHostCatalogEntries,
    emitProjectFileCatHumanContent,
    parseHostSoftwareArtifactsOption,
    parseHostSoftwareChannelsOption,
    waitForLro,
    ensureSyncKeyPair,
    resolveHostSshEndpoint,
    expandUserPath,
    parseHostMachineJson,
    parseOptionalPositiveInteger,
    inferRegionFromZone,
    HOST_CREATE_DISK_TYPES,
    HOST_CREATE_STORAGE_MODES,
    waitForHostCreateReady,
    resolveProject,
  } = deps;
  const host = program.command("host").description("host operations");

  host
    .command("list")
    .description("list hosts")
    .option("--include-deleted", "include deleted hosts")
    .option("--catalog", "include catalog-visible hosts")
    .option("--admin-view", "admin view")
    .option("--limit <n>", "max rows", "500")
    .action(
      async (
        opts: {
          includeDeleted?: boolean;
          catalog?: boolean;
          adminView?: boolean;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "host list", async (ctx) => {
          const rows = await listHosts(ctx, {
            include_deleted: !!opts.includeDeleted,
            catalog: !!opts.catalog,
            admin_view: !!opts.adminView,
          });
          const limitNum = Math.max(
            1,
            Math.min(10000, Number(opts.limit ?? "500") || 500),
          );
          return rows.slice(0, limitNum).map((row) => ({
            host_id: row.id,
            name: row.name,
            status: row.status ?? "",
            region: row.region ?? "",
            pricing_model: row.pricing_model ?? "on_demand",
            interruption_restore_policy:
              row.interruption_restore_policy ?? null,
            size: row.size ?? "",
            gpu: !!row.gpu,
            scope: row.scope ?? "",
            last_seen: row.last_seen ?? null,
            public_ip: row.public_ip ?? null,
          }));
        });
      },
    );

  host
    .command("catalog")
    .description("show cloud host catalog entries")
    .option(
      "--provider <provider>",
      "provider id: gcp, nebius, hyperstack, lambda, self-host",
      "gcp",
    )
    .option("--kind <kind...>", "filter catalog entries by kind")
    .option("--update", "refresh cloud catalog before fetching (admin only)")
    .action(
      async (
        opts: { provider?: string; kind?: string[]; update?: boolean },
        command: Command,
      ) => {
        await withContext(command, "host catalog", async (ctx) => {
          const provider = normalizeHostProviderValue(
            `${opts.provider ?? "gcp"}`,
          );
          if (opts.update) {
            await ctx.hub.hosts.updateCloudCatalog({ provider });
          }
          const catalog = await ctx.hub.hosts.getCatalog({ provider });
          const filteredEntries =
            opts.kind && opts.kind.length
              ? (catalog.entries ?? []).filter((entry) =>
                  opts.kind!.some(
                    (kind) =>
                      `${entry.kind ?? ""}`.trim().toLowerCase() ===
                      `${kind}`.trim().toLowerCase(),
                  ),
                )
              : (catalog.entries ?? []);
          if (ctx.globals.json || ctx.globals.output === "json") {
            return {
              ...catalog,
              entries: filteredEntries,
            };
          }
          return summarizeHostCatalogEntries(
            {
              ...catalog,
              entries: filteredEntries,
            },
            undefined,
          );
        });
      },
    );

  host
    .command("get <host>")
    .description("get one host by id or name")
    .action(async (hostIdentifier: string, command: Command) => {
      await withContext(command, "host get", async (ctx) => {
        const h = await resolveHost(ctx, hostIdentifier);
        return {
          host_id: h.id,
          name: h.name,
          status: h.status ?? "",
          region: h.region ?? "",
          pricing_model: h.pricing_model ?? "on_demand",
          interruption_restore_policy: h.interruption_restore_policy ?? null,
          size: h.size ?? "",
          gpu: !!h.gpu,
          scope: h.scope ?? "",
          last_seen: h.last_seen ?? null,
          public_ip: h.public_ip ?? null,
          machine: h.machine ?? null,
          version: h.version ?? null,
          project_bundle_version: h.project_bundle_version ?? null,
          tools_version: h.tools_version ?? null,
          bootstrap: h.bootstrap ?? null,
          bootstrap_lifecycle: h.bootstrap_lifecycle ?? null,
        };
      });
    });

  host
    .command("where <host>")
    .description("show the bay for one host by id or name")
    .action(async (hostIdentifier: string, command: Command) => {
      await withContext(command, "host where", async (ctx) => {
        const h = await resolveHost(ctx, hostIdentifier);
        return await ctx.hub.system.getHostBay({ host_id: h.id });
      });
    });

  host
    .command("bootstrap-status <host>")
    .description("show desired vs installed bootstrap/tool lifecycle state")
    .action(async (hostIdentifier: string, command: Command) => {
      await withContext(command, "host bootstrap-status", async (ctx) => {
        const h = await resolveHost(ctx, hostIdentifier);
        return {
          host_id: h.id,
          name: h.name,
          status: h.status ?? "",
          bootstrap: h.bootstrap ?? null,
          bootstrap_lifecycle: h.bootstrap_lifecycle ?? null,
        };
      });
    });

  host
    .command("metrics <host>")
    .description("show current and recent host metrics")
    .option("--window <window>", "history window: 30m, 1h, 24h", "1h")
    .option("--points <n>", "maximum history points", "60")
    .action(
      async (
        hostIdentifier: string,
        opts: { window?: string; points?: string },
        command: Command,
      ) => {
        await withContext(command, "host metrics", async (ctx) => {
          const h = await resolveHost(ctx, hostIdentifier);
          const max_points = Math.max(
            10,
            Math.min(1440, Number(opts.points ?? "60") || 60),
          );
          const history = await ctx.hub.hosts.getHostMetricsHistory({
            id: h.id,
            window_minutes: parseMetricsWindowMinutes(opts.window),
            max_points,
          });
          return {
            host_id: h.id,
            name: h.name,
            current: h.metrics?.current ?? null,
            history,
            derived: history?.derived ?? null,
          };
        });
      },
    );

  host
    .command("logs <host>")
    .description("tail project-host runtime log")
    .option("--tail <n>", "number of log lines", "200")
    .action(
      async (
        hostIdentifier: string,
        opts: { tail?: string },
        command: Command,
      ) => {
        await withContext(command, "host logs", async (ctx) => {
          const h = await resolveHost(ctx, hostIdentifier);
          const lines = Number(opts.tail ?? "200");
          if (!Number.isFinite(lines) || lines <= 0) {
            throw new Error("--tail must be a positive integer");
          }
          const log = (await ctx.hub.hosts.getHostRuntimeLog({
            id: h.id,
            lines: Math.floor(lines),
          })) as HostRuntimeLogRow;
          if (!ctx.globals.json && ctx.globals.output !== "json") {
            emitProjectFileCatHumanContent(log.text ?? "");
            return null;
          }
          return log;
        });
      },
    );

  host
    .command("versions")
    .description(
      "show available software versions (latest plus source-published history)",
    )
    .option(
      "--artifact <artifact...>",
      "artifact(s): project-host, project, tools (default: all)",
    )
    .option(
      "--channel <channel...>",
      "channel(s): latest, staging (default: latest)",
    )
    .option("--limit <n>", "max versions per artifact/channel", "10")
    .option(
      "--hub-source",
      "use this CoCalc site's /software endpoint as base URL",
    )
    .option("--base-url <url>", "software base url override")
    .option("--os <os>", "target OS: linux or darwin", "linux")
    .option("--arch <arch>", "target arch: amd64 or arm64", "amd64")
    .action(
      async (
        opts: {
          artifact?: string[];
          channel?: string[];
          limit?: string;
          hubSource?: boolean;
          baseUrl?: string;
          os?: string;
          arch?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "host versions", async (ctx) => {
          const artifacts = parseHostSoftwareArtifactsOption(opts.artifact);
          const channels = parseHostSoftwareChannelsOption(opts.channel);
          const osValue = `${opts.os ?? "linux"}`.trim().toLowerCase();
          if (osValue !== "linux" && osValue !== "darwin") {
            throw new Error("--os must be one of: linux, darwin");
          }
          const archValue = `${opts.arch ?? "amd64"}`.trim().toLowerCase();
          if (archValue !== "amd64" && archValue !== "arm64") {
            throw new Error("--arch must be one of: amd64, arm64");
          }
          const limit = Number(opts.limit ?? "10");
          if (!Number.isFinite(limit) || limit <= 0) {
            throw new Error("--limit must be a positive integer");
          }
          if (opts.baseUrl && opts.hubSource) {
            throw new Error("use either --base-url or --hub-source, not both");
          }
          const baseUrl = opts.hubSource
            ? `${ctx.apiBaseUrl.replace(/\/+$/, "")}/software`
            : opts.baseUrl;
          const rows = (await ctx.hub.hosts.listHostSoftwareVersions({
            base_url: baseUrl,
            artifacts,
            channels,
            os: osValue,
            arch: archValue,
            history_limit: Math.floor(limit),
          })) as HostSoftwareVersionRow[];
          if (!ctx.globals.json && ctx.globals.output !== "json") {
            return rows.map(({ sha256: _sha256, ...rest }) => rest);
          }
          return rows;
        });
      },
    );

  host
    .command("upgrade [host]")
    .description("upgrade host software")
    .option(
      "--artifact <artifact...>",
      "artifact(s): project-host, project, tools (default: all)",
    )
    .option("--channel <channel>", "channel: latest or staging", "latest")
    .option("--version <version>", "explicit version (overrides channel)")
    .option(
      "--hub-source",
      "use this CoCalc site's /software endpoint as base URL",
    )
    .option("--base-url <url>", "software base url override")
    .option("--all-online", "upgrade all online hosts")
    .option("--wait", "wait for completion")
    .action(
      async (
        hostIdentifier: string | undefined,
        opts: {
          artifact?: string[];
          channel?: string;
          version?: string;
          hubSource?: boolean;
          baseUrl?: string;
          allOnline?: boolean;
          wait?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "host upgrade", async (ctx) => {
          if (hostIdentifier && opts.allOnline) {
            throw new Error("use either <host> or --all-online, not both");
          }
          if (!hostIdentifier && !opts.allOnline) {
            throw new Error("specify <host> or use --all-online");
          }
          const artifacts = parseHostSoftwareArtifactsOption(opts.artifact);
          const channelRaw = `${opts.channel ?? "latest"}`.trim().toLowerCase();
          const channel: HostSoftwareChannel =
            channelRaw === "staging" ? "staging" : "latest";
          if (channelRaw !== "latest" && channelRaw !== "staging") {
            throw new Error("--channel must be one of: latest, staging");
          }
          const version = `${opts.version ?? ""}`.trim() || undefined;
          if (opts.baseUrl && opts.hubSource) {
            throw new Error("use either --base-url or --hub-source, not both");
          }
          const baseUrl = opts.hubSource
            ? `${ctx.apiBaseUrl.replace(/\/+$/, "")}/software`
            : opts.baseUrl;
          const targets = artifacts.map((artifact) => ({
            artifact,
            ...(version ? { version } : { channel }),
          }));
          const hosts = opts.allOnline
            ? (
                (await listHosts(ctx, {
                  include_deleted: false,
                  catalog: false,
                  admin_view: true,
                })) as HostRow[]
              ).filter(isHostOnlineForUpgrade)
            : [await resolveHost(ctx, hostIdentifier)];

          if (hosts.length === 0) {
            return {
              status: "skipped",
              reason: "no online hosts matched",
              targets,
              hosts: [],
            };
          }

          const queued = await Promise.all(
            hosts.map(async (h) => {
              const op = await ctx.hub.hosts.upgradeHostSoftware({
                id: h.id,
                targets,
                base_url: baseUrl,
              });
              return {
                host_id: h.id,
                name: h.name,
                op_id: op.op_id,
                status: "queued",
              };
            }),
          );

          if (!opts.wait) {
            if (queued.length === 1) {
              return {
                host_id: queued[0].host_id,
                op_id: queued[0].op_id,
                status: queued[0].status,
                targets,
              };
            }
            return {
              status: "queued",
              count: queued.length,
              targets,
              hosts: queued,
            };
          }

          const waited = await Promise.all(
            queued.map(async (entry) => {
              const summary = await waitForLro(ctx, entry.op_id, {
                timeoutMs: ctx.timeoutMs,
                pollMs: ctx.pollMs,
              });
              return {
                ...entry,
                status: summary.status,
                timed_out: !!summary.timedOut,
                error: summary.error ?? undefined,
              };
            }),
          );

          const failures = waited.filter(
            (entry) => entry.timed_out || entry.status !== "succeeded",
          );
          if (failures.length > 0) {
            throw new Error(
              failures
                .map((entry) => {
                  if (entry.timed_out) {
                    return `${entry.name ?? entry.host_id}: timed out (op=${entry.op_id}, last_status=${entry.status})`;
                  }
                  return `${entry.name ?? entry.host_id}: status=${entry.status} error=${entry.error ?? "unknown"}`;
                })
                .join("; "),
            );
          }

          if (waited.length === 1) {
            return {
              host_id: waited[0].host_id,
              op_id: waited[0].op_id,
              status: waited[0].status,
              targets,
            };
          }
          return {
            status: "succeeded",
            count: waited.length,
            targets,
            hosts: waited,
          };
        });
      },
    );

  host
    .command("reconcile [host]")
    .description("run bootstrap/software reconcile on one or more hosts")
    .option("--all-online", "reconcile all online hosts")
    .option("--wait", "wait for completion")
    .action(
      async (
        hostIdentifier: string | undefined,
        opts: { allOnline?: boolean; wait?: boolean },
        command: Command,
      ) => {
        await withContext(command, "host reconcile", async (ctx) => {
          if (hostIdentifier && opts.allOnline) {
            throw new Error("use either <host> or --all-online, not both");
          }
          if (!hostIdentifier && !opts.allOnline) {
            throw new Error("specify <host> or use --all-online");
          }
          const hosts = opts.allOnline
            ? (
                (await listHosts(ctx, {
                  include_deleted: false,
                  catalog: false,
                  admin_view: true,
                })) as HostRow[]
              ).filter(isHostOnlineForUpgrade)
            : [await resolveHost(ctx, hostIdentifier)];

          if (hosts.length === 0) {
            return {
              status: "skipped",
              reason: "no online hosts matched",
              hosts: [],
            };
          }

          const queued = await Promise.all(
            hosts.map(async (h) => {
              const op = await ctx.hub.hosts.reconcileHostSoftware({
                id: h.id,
              });
              return {
                host_id: h.id,
                name: h.name,
                op_id: op.op_id,
                status: "queued",
              };
            }),
          );

          if (!opts.wait) {
            if (queued.length === 1) {
              return {
                host_id: queued[0].host_id,
                op_id: queued[0].op_id,
                status: queued[0].status,
              };
            }
            return {
              status: "queued",
              count: queued.length,
              hosts: queued,
            };
          }

          const waited = await Promise.all(
            queued.map(async (entry) => {
              const summary = await waitForLro(ctx, entry.op_id, {
                timeoutMs: ctx.timeoutMs,
                pollMs: ctx.pollMs,
              });
              return {
                ...entry,
                status: summary.status,
                timed_out: !!summary.timedOut,
                error: summary.error ?? undefined,
              };
            }),
          );

          const failures = waited.filter(
            (entry) => entry.timed_out || entry.status !== "succeeded",
          );
          if (failures.length > 0) {
            throw new Error(
              failures
                .map((entry) => {
                  if (entry.timed_out) {
                    return `${entry.name ?? entry.host_id}: timed out (op=${entry.op_id}, last_status=${entry.status})`;
                  }
                  return `${entry.name ?? entry.host_id}: status=${entry.status} error=${entry.error ?? "unknown"}`;
                })
                .join("; "),
            );
          }
          if (waited.length === 1) {
            return {
              host_id: waited[0].host_id,
              op_id: waited[0].op_id,
              status: waited[0].status,
            };
          }
          return {
            status: "succeeded",
            count: waited.length,
            hosts: waited,
          };
        });
      },
    );

  host
    .command("rollout <host>")
    .description(
      "restart or drain managed host components using the software already installed on the host",
    )
    .requiredOption(
      "--component <component...>",
      "component(s): project-host, conat-router, conat-persist, acp-worker",
    )
    .option("--reason <reason>", "optional rollout reason")
    .option("--wait", "wait for completion")
    .addHelpText(
      "after",
      `
Rollout does not publish or download new software.

Use \`cocalc host upgrade\` first when you want a host to pick up a newer
project-host bundle, project bundle, or tools version. Rollout then applies
component-specific lifecycle actions against whatever bundle/config is already
current on that host.

The \`<host>\` argument accepts either the operator-assigned host name or the
\`host_id\`.

Component behavior:
- \`project-host\`: schedule a restart of the current project-host daemon.
- \`conat-router\`: restart the managed local router from the current project-host bundle.
- \`conat-persist\`: restart the managed local persist daemon from the current project-host bundle.
- \`acp-worker\`: request drain of the active ACP worker and ensure a replacement is running from the current project-host bundle. If no worker is running, spawn one. If the worker is not rolling-capable, terminate it and replace it.

Example:
  cocalc host upgrade my-project-host --artifact project-host --hub-source --wait
  cocalc host rollout my-project-host --component acp-worker --wait
  cocalc host rollout 8daeccaf-67dd-4f75-a1b1-61063710dcc9 --component acp-worker --wait
`,
    )
    .action(
      async (
        hostIdentifier: string,
        opts: {
          component?: string[];
          reason?: string;
          wait?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "host rollout", async (ctx) => {
          const host = await resolveHost(ctx, hostIdentifier);
          const components = parseManagedComponentKindsOption(opts.component);
          const op = await ctx.hub.hosts.rolloutHostManagedComponents({
            id: host.id,
            components,
            reason: `${opts.reason ?? ""}`.trim() || undefined,
          });
          if (!opts.wait) {
            return {
              host_id: host.id,
              op_id: op.op_id,
              status: "queued",
              components,
            };
          }
          const summary = await waitForLro(ctx, op.op_id, {
            timeoutMs: ctx.timeoutMs,
            pollMs: ctx.pollMs,
          });
          if (summary.timedOut) {
            throw new Error(
              `${host.name ?? host.id}: timed out (op=${op.op_id}, last_status=${summary.status})`,
            );
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `${host.name ?? host.id}: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }
          return {
            host_id: host.id,
            op_id: op.op_id,
            status: summary.status,
            components,
          };
        });
      },
    );

  const deploy = host
    .command("deploy")
    .description("inspect or set desired runtime deployment state");

  deploy
    .command("status <host>")
    .description("show desired runtime deployment state for one host")
    .addHelpText(
      "after",
      `
Status shows two views:
- \`configured\`: host-specific overrides recorded for this host
- \`effective\`: the merged desired state after applying global defaults and host overrides
- \`observed_components\`: live component status reported by the host when it is online
- \`observed_targets\`: desired-vs-observed comparison for each effective runtime target
`,
    )
    .action(async (hostIdentifier: string, command: Command) => {
      await withContext(command, "host deploy status", async (ctx) => {
        const host = await resolveHost(ctx, hostIdentifier);
        const status = await ctx.hub.hosts.getHostRuntimeDeploymentStatus({
          id: host.id,
        });
        return {
          host_id: host.id,
          name: host.name ?? undefined,
          configured: status.configured,
          effective: status.effective,
          observed_components: status.observed_components,
          observed_targets: status.observed_targets,
          observation_error: status.observation_error,
        };
      });
    });

  deploy
    .command("set")
    .description(
      "upsert desired runtime deployment state for one host or for the global default scope",
    )
    .requiredOption("--version <version>", "desired version")
    .option("--host <host>", "target one host by name or host_id")
    .option("--global", "target the global default scope (admin only)")
    .option(
      "--component <component>",
      "component: project-host, conat-router, conat-persist, acp-worker",
    )
    .option(
      "--artifact <artifact>",
      "artifact: project-host, project-bundle, tools, bootstrap-environment",
    )
    .option("--policy <policy>", "restart_now or drain_then_replace")
    .option(
      "--drain-deadline-seconds <seconds>",
      "optional drain deadline in seconds",
    )
    .option("--reason <reason>", "optional rollout reason")
    .option(
      "--replace",
      "replace the entire selected scope instead of upserting",
    )
    .addHelpText(
      "after",
      `
This command records desired state. It does not itself publish software or
restart anything. Existing \`host upgrade\` and \`host rollout\` remain the
low-level imperative path while the desired-state flow is being built out.

Examples:
  cocalc host deploy set --host my-project-host --component acp-worker --version 20260415T061257Z-c97e9c71486d
  cocalc host deploy set --global --artifact project-bundle --version 20260415T061257Z-c97e9c71486d
`,
    )
    .action(
      async (
        opts: {
          host?: string;
          global?: boolean;
          component?: string;
          artifact?: string;
          version?: string;
          policy?: string;
          drainDeadlineSeconds?: string;
          reason?: string;
          replace?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "host deploy set", async (ctx) => {
          const scope_type = opts.global ? "global" : "host";
          if (!!opts.global === !!opts.host) {
            throw new Error("specify exactly one of --host or --global");
          }
          const target = parseRuntimeDeploymentTarget(opts);
          const policy = parseRuntimeDeploymentPolicy(opts.policy);
          const drain_deadline_seconds =
            opts.drainDeadlineSeconds == null
              ? undefined
              : parseOptionalPositiveInteger(
                  opts.drainDeadlineSeconds,
                  "--drain-deadline-seconds",
                );
          const resolvedHost = opts.host
            ? await resolveHost(ctx, opts.host)
            : undefined;
          const deployments = await ctx.hub.hosts.setHostRuntimeDeployments({
            scope_type,
            id: resolvedHost?.id,
            deployments: [
              {
                ...target,
                desired_version: `${opts.version ?? ""}`.trim(),
                rollout_policy: policy,
                drain_deadline_seconds,
                rollout_reason: `${opts.reason ?? ""}`.trim() || undefined,
              },
            ],
            replace: !!opts.replace,
          });
          return {
            scope_type,
            host_id: resolvedHost?.id,
            host_name: resolvedHost?.name,
            deployments,
          };
        });
      },
    );

  host
    .command("ssh <host>")
    .description("ssh into host (owner-only key install supported)")
    .option("--user <user>", "ssh username", "ubuntu")
    .option("--port <port>", "override ssh port")
    .option("--identity <path>", "ssh private key path")
    .option(
      "--install-key",
      "install local public key into host authorized_keys",
    )
    .option(
      "--key-path <path>",
      "ssh key base path (default: ~/.ssh/id_ed25519)",
    )
    .option("--print", "print ssh command without connecting")
    .option("--no-connect", "do not open ssh session")
    .action(
      async (
        hostIdentifier: string,
        opts: {
          user?: string;
          port?: string;
          identity?: string;
          installKey?: boolean;
          keyPath?: string;
          print?: boolean;
          connect?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "host ssh", async (ctx) => {
          const endpoint = await resolveHostSshEndpoint(ctx, hostIdentifier);
          let installResult:
            | (HostSshAuthorizedKeysRow & { added: boolean })
            | null = null;
          let keyInfo: any = null;
          if (opts.installKey) {
            keyInfo = await ensureSyncKeyPair(opts.keyPath);
            installResult = (await ctx.hub.hosts.addHostSshAuthorizedKey({
              id: endpoint.host.id,
              public_key: keyInfo.public_key,
            })) as HostSshAuthorizedKeysRow & { added: boolean };
          }

          const user = `${opts.user ?? "ubuntu"}`.trim() || "ubuntu";
          const parsedPort = opts.port == null ? undefined : Number(opts.port);
          if (
            parsedPort != null &&
            (!Number.isInteger(parsedPort) ||
              parsedPort <= 0 ||
              parsedPort > 65535)
          ) {
            throw new Error("--port must be an integer between 1 and 65535");
          }
          const port = parsedPort ?? endpoint.ssh_port ?? undefined;
          const sshTarget = `${user}@${endpoint.ssh_host}`;
          const sshArgs: string[] = [];
          if (port != null) {
            sshArgs.push("-p", String(port));
          }
          if (opts.identity) {
            sshArgs.push("-i", expandUserPath(opts.identity));
          }
          sshArgs.push(sshTarget);
          const sshCommand = `ssh ${sshArgs.map((arg) => JSON.stringify(arg)).join(" ")}`;

          if (ctx.globals.json || ctx.globals.output === "json") {
            if (opts.print === false && opts.connect !== false) {
              throw new Error(
                "interactive ssh is not supported with --json; use --print or --no-connect",
              );
            }
            return {
              host_id: endpoint.host.id,
              host_name: endpoint.host.name,
              ssh_server: endpoint.ssh_server,
              ssh_host: endpoint.ssh_host,
              ssh_port: port ?? null,
              ssh_target: sshTarget,
              command: sshCommand,
              key_installed: installResult?.added ?? false,
              key_path: keyInfo?.public_key_path ?? null,
            };
          }

          if (opts.print || opts.connect === false) {
            return {
              host_id: endpoint.host.id,
              host_name: endpoint.host.name,
              ssh_server: endpoint.ssh_server,
              ssh_host: endpoint.ssh_host,
              ssh_port: port ?? null,
              ssh_target: sshTarget,
              command: sshCommand,
              key_installed: installResult?.added ?? false,
              key_path: keyInfo?.public_key_path ?? null,
            };
          }

          const result = spawnSync("ssh", sshArgs, { stdio: "inherit" });
          if (result.error) {
            throw new Error(`failed to run ssh: ${result.error.message}`);
          }
          const status = result.status ?? 0;
          if (status !== 0) {
            throw new Error(`ssh exited with code ${status}`);
          }
          return {
            host_id: endpoint.host.id,
            host_name: endpoint.host.name,
            ssh_target: sshTarget,
            key_installed: installResult?.added ?? false,
            key_path: keyInfo?.public_key_path ?? null,
            status: "connected",
          };
        });
      },
    );

  host
    .command("create <name>")
    .description("create a cloud host record (non-self provider)")
    .requiredOption("--provider <provider>", "provider id, e.g. gcp")
    .option(
      "--region <region>",
      "provider region (inferred from --zone when possible)",
    )
    .option("--size <size>", "size label (defaults to --machine-type when set)")
    .option("--gpu", "mark host as gpu-enabled")
    .option("--pricing-model <model>", "on_demand|spot", "on_demand")
    .option("--interruption-restore-policy <policy>", "none|immediate")
    .option("--machine-type <machineType>", "provider machine type")
    .option("--zone <zone>", "provider zone")
    .option("--disk-gb <diskGb>", "boot disk size in GB")
    .option(
      "--disk-type <diskType>",
      "disk type: ssd|balanced|standard|ssd_io_m3",
    )
    .option(
      "--storage-mode <storageMode>",
      "storage mode: persistent|ephemeral",
      "persistent",
    )
    .option("--machine-json <json>", "additional machine JSON object")
    .option("--wait", "wait for host to become running")
    .action(
      async (
        name: string,
        opts: {
          provider: string;
          region?: string;
          size?: string;
          gpu?: boolean;
          pricingModel?: string;
          interruptionRestorePolicy?: string;
          machineType?: string;
          zone?: string;
          diskGb?: string;
          diskType?: string;
          storageMode?: string;
          machineJson?: string;
          wait?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "host create", async (ctx) => {
          const provider = normalizeHostProviderValue(opts.provider);
          if (provider === "self-host") {
            throw new Error(
              "non-self host create does not support provider 'self-host'; use host create-self",
            );
          }

          const machine = parseHostMachineJson(opts.machineJson);
          machine.cloud = provider;

          const machineType = `${opts.machineType ?? ""}`.trim();
          if (machineType) {
            machine.machine_type = machineType;
          }
          const zone = `${opts.zone ?? ""}`.trim();
          if (zone) {
            machine.zone = zone;
          }

          const diskGb = parseOptionalPositiveInteger(opts.diskGb, "--disk-gb");
          if (diskGb != null) {
            machine.disk_gb = diskGb;
          }

          const diskTypeRaw = `${opts.diskType ?? ""}`.trim().toLowerCase();
          if (diskTypeRaw) {
            if (!HOST_CREATE_DISK_TYPES.has(diskTypeRaw)) {
              throw new Error(
                `--disk-type must be one of: ${Array.from(HOST_CREATE_DISK_TYPES).join(", ")}`,
              );
            }
            machine.disk_type = diskTypeRaw as HostMachine["disk_type"];
          }

          const storageModeRaw = `${opts.storageMode ?? ""}`
            .trim()
            .toLowerCase();
          if (storageModeRaw) {
            if (!HOST_CREATE_STORAGE_MODES.has(storageModeRaw)) {
              throw new Error(
                `--storage-mode must be one of: ${Array.from(HOST_CREATE_STORAGE_MODES).join(", ")}`,
              );
            }
            machine.storage_mode =
              storageModeRaw as HostMachine["storage_mode"];
          }

          const region =
            `${opts.region ?? ""}`.trim() || inferRegionFromZone(machine.zone);
          if (!region) {
            throw new Error(
              "--region is required (or provide a zonal --zone like 'us-west1-a' to infer region)",
            );
          }

          const size =
            `${opts.size ?? ""}`.trim() ||
            `${machine.machine_type ?? ""}`.trim();
          if (!size) {
            throw new Error("--size is required (or provide --machine-type)");
          }

          const gpu = !!opts.gpu || Number(machine.gpu_count ?? 0) > 0;
          const created = (await ctx.hub.hosts.createHost({
            name,
            region,
            size,
            gpu,
            pricing_model: opts.pricingModel as any,
            interruption_restore_policy:
              (opts.interruptionRestorePolicy as any) ?? undefined,
            machine,
          })) as HostRow;

          if (!opts.wait) {
            return {
              host_id: created.id,
              name: created.name,
              provider,
              region: created.region ?? region,
              pricing_model: created.pricing_model ?? "on_demand",
              interruption_restore_policy:
                created.interruption_restore_policy ?? null,
              size: created.size ?? size,
              status: created.status ?? "",
              gpu: !!created.gpu,
            };
          }

          const progressReporter = createHostProgressReporter(ctx);
          const waited = await waitForHostCreateReady(ctx, created.id, {
            timeoutMs: ctx.timeoutMs,
            pollMs: ctx.pollMs,
            onProgress: progressReporter,
          });
          if (waited.timedOut) {
            throw new Error(
              `host create timed out after ${ctx.timeoutMs}ms (host_id=${created.id}, last_status=${waited.host.status ?? "unknown"}${formatBootstrapTimeoutDetail(waited.host)})`,
            );
          }

          return {
            host_id: waited.host.id,
            name: waited.host.name,
            provider,
            region: waited.host.region ?? region,
            pricing_model: waited.host.pricing_model ?? "on_demand",
            interruption_restore_policy:
              waited.host.interruption_restore_policy ?? null,
            size: waited.host.size ?? size,
            status: waited.host.status ?? "",
            gpu: !!waited.host.gpu,
            waited: true,
          };
        });
      },
    );

  host
    .command("create-self <name>")
    .description("create a self-host host record")
    .requiredOption("--ssh-target <target>", "ssh target, e.g. ubuntu@10.0.0.2")
    .option("--region <region>", "region label", "pending")
    .option("--size <size>", "size label", "custom")
    .option("--cpu <count>", "cpu count", "2")
    .option("--ram-gb <gb>", "ram in GB", "8")
    .option("--disk-gb <gb>", "disk in GB", "40")
    .option("--gpu", "mark host as having gpu")
    .option("--pricing-model <model>", "on_demand|spot", "on_demand")
    .option("--interruption-restore-policy <policy>", "none|immediate")
    .action(
      async (
        name: string,
        opts: {
          sshTarget: string;
          region?: string;
          size?: string;
          cpu?: string;
          ramGb?: string;
          diskGb?: string;
          gpu?: boolean;
          pricingModel?: string;
          interruptionRestorePolicy?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "host create-self", async (ctx) => {
          const cpu = Math.max(1, Number(opts.cpu ?? "2") || 2);
          const ram_gb = Math.max(1, Number(opts.ramGb ?? "8") || 8);
          const disk_gb = Math.max(10, Number(opts.diskGb ?? "40") || 40);
          const host = (await ctx.hub.hosts.createHost({
            name,
            region: opts.region ?? "pending",
            size: opts.size ?? "custom",
            gpu: !!opts.gpu,
            pricing_model: opts.pricingModel as any,
            interruption_restore_policy:
              (opts.interruptionRestorePolicy as any) ?? undefined,
            machine: {
              cloud: "self-host",
              storage_mode: "persistent",
              disk_gb,
              metadata: {
                cpu,
                ram_gb,
                self_host_mode: "local",
                self_host_kind: "direct",
                self_host_ssh_target: opts.sshTarget,
              },
            },
          })) as HostRow;
          return {
            host_id: host.id,
            name: host.name,
            status: host.status ?? "",
            region: host.region ?? "",
            pricing_model: host.pricing_model ?? "on_demand",
            interruption_restore_policy:
              host.interruption_restore_policy ?? null,
            size: host.size ?? "",
            gpu: !!host.gpu,
          };
        });
      },
    );

  host
    .command("start <host>")
    .description("start a host")
    .option("--wait", "wait for completion")
    .action(
      async (
        hostIdentifier: string,
        opts: { wait?: boolean },
        command: Command,
      ) => {
        await withContext(command, "host start", async (ctx) => {
          const h = await resolveHost(ctx, hostIdentifier);
          const op = await ctx.hub.hosts.startHost({ id: h.id });
          if (!opts.wait) {
            return {
              host_id: h.id,
              op_id: op.op_id,
              status: "queued",
            };
          }
          const waitStarted = Date.now();
          const summary = await waitForLro(ctx, op.op_id, {
            timeoutMs: ctx.timeoutMs,
            pollMs: ctx.pollMs,
          });
          if (summary.timedOut) {
            throw new Error(
              `host start timed out (op=${op.op_id}, last_status=${summary.status})`,
            );
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `host start failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }
          const progressReporter = createHostProgressReporter(ctx);
          const waited = await waitForHostCreateReady(ctx, h.id, {
            timeoutMs: Math.max(
              ctx.pollMs,
              ctx.timeoutMs - (Date.now() - waitStarted),
            ),
            pollMs: ctx.pollMs,
            onProgress: progressReporter,
          });
          if (waited.timedOut) {
            throw new Error(
              `host start timed out after ${ctx.timeoutMs}ms (op=${op.op_id}, last_status=${waited.host.status ?? "unknown"}${formatBootstrapTimeoutDetail(waited.host)})`,
            );
          }
          return {
            host_id: waited.host.id,
            op_id: op.op_id,
            status: summary.status,
            waited: true,
          };
        });
      },
    );

  host
    .command("stop <host>")
    .description("stop a host")
    .option("--skip-backups", "skip creating backups before stop")
    .option("--wait", "wait for completion")
    .action(
      async (
        hostIdentifier: string,
        opts: { skipBackups?: boolean; wait?: boolean },
        command: Command,
      ) => {
        await withContext(command, "host stop", async (ctx) => {
          const h = await resolveHost(ctx, hostIdentifier);
          const op = await ctx.hub.hosts.stopHost({
            id: h.id,
            skip_backups: !!opts.skipBackups,
          });
          if (!opts.wait) {
            return {
              host_id: h.id,
              op_id: op.op_id,
              status: "queued",
            };
          }
          const summary = await waitForLro(ctx, op.op_id, {
            timeoutMs: ctx.timeoutMs,
            pollMs: ctx.pollMs,
          });
          if (summary.timedOut) {
            throw new Error(
              `host stop timed out (op=${op.op_id}, last_status=${summary.status})`,
            );
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `host stop failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }
          return {
            host_id: h.id,
            op_id: op.op_id,
            status: summary.status,
          };
        });
      },
    );

  host
    .command("restart <host>")
    .description("restart a host")
    .option("--mode <mode>", "restart mode: reboot or hard", "reboot")
    .option("--hard", "same as --mode hard")
    .option("--wait", "wait for completion")
    .action(
      async (
        hostIdentifier: string,
        opts: { mode?: string; hard?: boolean; wait?: boolean },
        command: Command,
      ) => {
        await withContext(command, "host restart", async (ctx) => {
          const h = await resolveHost(ctx, hostIdentifier);
          const modeRaw = `${opts.mode ?? "reboot"}`.trim().toLowerCase();
          const mode = opts.hard ? "hard" : modeRaw;
          if (mode !== "reboot" && mode !== "hard") {
            throw new Error(
              `invalid --mode '${opts.mode}' (expected reboot or hard)`,
            );
          }
          const op = await ctx.hub.hosts.restartHost({
            id: h.id,
            mode,
          });
          if (!opts.wait) {
            return {
              host_id: h.id,
              op_id: op.op_id,
              mode,
              status: "queued",
            };
          }
          const waitStarted = Date.now();
          const summary = await waitForLro(ctx, op.op_id, {
            timeoutMs: ctx.timeoutMs,
            pollMs: ctx.pollMs,
          });
          if (summary.timedOut) {
            throw new Error(
              `host restart timed out (op=${op.op_id}, last_status=${summary.status})`,
            );
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `host restart failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }
          const progressReporter = createHostProgressReporter(ctx);
          const waited = await waitForHostCreateReady(ctx, h.id, {
            timeoutMs: Math.max(
              ctx.pollMs,
              ctx.timeoutMs - (Date.now() - waitStarted),
            ),
            pollMs: ctx.pollMs,
            onProgress: progressReporter,
          });
          if (waited.timedOut) {
            throw new Error(
              `host restart timed out after ${ctx.timeoutMs}ms (op=${op.op_id}, last_status=${waited.host.status ?? "unknown"}${formatBootstrapTimeoutDetail(waited.host)})`,
            );
          }
          return {
            host_id: waited.host.id,
            op_id: op.op_id,
            mode,
            status: summary.status,
            waited: true,
          };
        });
      },
    );

  host
    .command("drain <host>")
    .description("move all projects off a host (or unassign with --force)")
    .option(
      "--dest-host <host>",
      "destination host id or name (default: auto-select)",
    )
    .option(
      "--force",
      "force drain by setting host_id=null on assigned projects",
    )
    .option(
      "--parallel <n>",
      "number of project moves to run concurrently (default: 10; non-admin max: 15)",
    )
    .option(
      "--allow-offline",
      "allow moves when source host is offline and backups may be stale",
    )
    .option("--wait", "wait for completion")
    .action(
      async (
        hostIdentifier: string,
        opts: {
          destHost?: string;
          force?: boolean;
          parallel?: string;
          allowOffline?: boolean;
          wait?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "host drain", async (ctx) => {
          const source = await resolveHost(ctx, hostIdentifier);
          const dest = opts.destHost
            ? await resolveHost(ctx, opts.destHost)
            : null;
          let requestedParallel: number | undefined;
          if (opts.parallel != null) {
            const parsedParallel = Math.floor(Number(opts.parallel));
            if (!Number.isFinite(parsedParallel) || parsedParallel < 1) {
              throw new Error("--parallel must be a positive integer");
            }
            requestedParallel = parsedParallel;
          }
          if (dest && dest.id === source.id) {
            throw new Error("destination host must differ from source host");
          }

          const op = await ctx.hub.hosts.drainHost({
            id: source.id,
            ...(dest ? { dest_host_id: dest.id } : {}),
            force: !!opts.force,
            allow_offline: !!opts.allowOffline,
            ...(requestedParallel != null
              ? { parallel: requestedParallel }
              : {}),
          });

          if (!opts.wait) {
            return {
              host_id: source.id,
              op_id: op.op_id,
              status: "queued",
              mode: opts.force ? "force" : "move",
              dest_host_id: dest?.id ?? null,
              parallel: requestedParallel ?? 10,
            };
          }

          const summary = await waitForLro(ctx, op.op_id, {
            timeoutMs: ctx.timeoutMs,
            pollMs: ctx.pollMs,
          });
          if (summary.timedOut) {
            throw new Error(
              `host drain timed out (op=${op.op_id}, last_status=${summary.status})`,
            );
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `host drain failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }
          const final = await ctx.hub.lro.get({ op_id: op.op_id });
          return {
            host_id: source.id,
            op_id: op.op_id,
            status: summary.status,
            mode: opts.force ? "force" : "move",
            dest_host_id: dest?.id ?? null,
            drain: final?.result?.drain ?? null,
            parallel: requestedParallel ?? 10,
          };
        });
      },
    );

  host
    .command("delete <host>")
    .description("deprovision a host")
    .option("--skip-backups", "skip creating backups before deprovision")
    .option("--wait", "wait for completion")
    .action(
      async (
        hostIdentifier: string,
        opts: { skipBackups?: boolean; wait?: boolean },
        command: Command,
      ) => {
        await withContext(command, "host delete", async (ctx) => {
          const h = await resolveHost(ctx, hostIdentifier);
          const op = await ctx.hub.hosts.deleteHost({
            id: h.id,
            skip_backups: !!opts.skipBackups,
          });
          if (!opts.wait) {
            return {
              host_id: h.id,
              op_id: op.op_id,
              status: "queued",
            };
          }
          const summary = await waitForLro(ctx, op.op_id, {
            timeoutMs: ctx.timeoutMs,
            pollMs: ctx.pollMs,
          });
          if (summary.timedOut) {
            throw new Error(
              `host delete timed out (op=${op.op_id}, last_status=${summary.status})`,
            );
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `host delete failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }
          return {
            host_id: h.id,
            op_id: op.op_id,
            status: summary.status,
          };
        });
      },
    );

  host
    .command("resolve-connection <host>")
    .description("resolve host connection info")
    .action(async (hostIdentifier: string, command: Command) => {
      await withContext(command, "host resolve-connection", async (ctx) => {
        const h = await resolveHost(ctx, hostIdentifier);
        return await ctx.hub.hosts.resolveHostConnection({ host_id: h.id });
      });
    });

  host
    .command("issue-http-token")
    .description("issue a project-host HTTP auth token")
    .requiredOption("--host <host>", "host id or name")
    .option("--project <project>", "project id or name")
    .option("--ttl <seconds>", "token TTL in seconds")
    .action(
      async (
        opts: { host: string; project?: string; ttl?: string },
        command: Command,
      ) => {
        await withContext(command, "host issue-http-token", async (ctx) => {
          const h = await resolveHost(ctx, opts.host);
          const ws = opts.project
            ? await resolveProject(ctx, opts.project)
            : null;
          const ttl = opts.ttl ? Number(opts.ttl) : undefined;
          const token = await ctx.hub.hosts.issueProjectHostAuthToken({
            host_id: h.id,
            project_id: ws?.project_id,
            ttl_seconds: ttl,
          });
          return {
            host_id: token.host_id,
            project_id: ws?.project_id ?? null,
            token: token.token,
            expires_at: token.expires_at,
          };
        });
      },
    );

  return host;
}
