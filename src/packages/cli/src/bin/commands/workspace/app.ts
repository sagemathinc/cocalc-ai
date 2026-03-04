/**
 * Workspace app server lifecycle commands.
 *
 * Phase 0 intentionally keeps this JSON-first and deterministic for agent flows.
 */
import { Command } from "commander";

import type { WorkspaceCommandDeps } from "../workspace";

function parsePositiveIntOrThrow(value: string | undefined, context: string): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${context} must be a positive integer`);
  }
  return n;
}

function normalizePrefix(value: string): string {
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

export function registerWorkspaceAppCommands(
  workspace: Command,
  deps: WorkspaceCommandDeps,
): void {
  const { withContext, resolveWorkspaceProjectApi, resolveWorkspaceFromArgOrContext, readFileLocal } =
    deps;

  const app = workspace
    .command("app")
    .description("workspace app server specs and lifecycle");

  app
    .command("list")
    .description("list app specs with runtime status")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .action(async (opts: { workspace?: string }, command: Command) => {
      await withContext(command, "workspace app list", async (ctx) => {
        const { workspace: ws, api } = await resolveWorkspaceProjectApi(
          ctx,
          opts.workspace,
        );
        const rows = await api.apps.listAppStatuses();
        return {
          workspace_id: ws.project_id,
          items: rows,
        };
      });
    });

  app
    .command("get <appId>")
    .description("get one app spec")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .action(
      async (
        appId: string,
        opts: { workspace?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app get", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const spec = await api.apps.getAppSpec(appId);
          return {
            workspace_id: ws.project_id,
            app_id: spec.id,
            spec,
          };
        });
      },
    );

  app
    .command("upsert")
    .description("create/update app spec from a local JSON file")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .requiredOption("--file <path>", "local path to JSON app spec")
    .action(
      async (
        opts: { workspace?: string; file: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app upsert", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const raw = await readFileLocal(opts.file, "utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            throw new Error(
              `failed to parse --file as JSON (${opts.file}): ${err}; phase-0 app specs are JSON`,
            );
          }
          const saved = await api.apps.upsertAppSpec(parsed);
          return {
            workspace_id: ws.project_id,
            app_id: saved.id,
            path: saved.path,
            spec: saved.spec,
          };
        });
      },
    );

  app
    .command("delete <appId>")
    .description("delete app spec")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .action(
      async (
        appId: string,
        opts: { workspace?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app delete", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const result = await api.apps.deleteApp(appId);
          return {
            workspace_id: ws.project_id,
            ...result,
          };
        });
      },
    );

  app
    .command("start <appId>")
    .description("start app process")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--wait", "wait for running+ready state")
    .option("--timeout <duration>", "wait timeout (e.g. 30s, 2m)")
    .action(
      async (
        appId: string,
        opts: { workspace?: string; wait?: boolean; timeout?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app start", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          if (opts.wait) {
            const timeout = opts.timeout ? deps.durationToMs(opts.timeout) : undefined;
            const status = await api.apps.ensureRunning(appId, {
              timeout,
              interval: 500,
            });
            return {
              workspace_id: ws.project_id,
              ...status,
            };
          }
          const status = await api.apps.startApp(appId);
          return {
            workspace_id: ws.project_id,
            ...status,
          };
        });
      },
    );

  app
    .command("stop <appId>")
    .description("stop app process")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .action(
      async (
        appId: string,
        opts: { workspace?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app stop", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          await api.apps.stopApp(appId);
          const status = await api.apps.statusApp(appId);
          return {
            workspace_id: ws.project_id,
            ...status,
          };
        });
      },
    );

  app
    .command("restart <appId>")
    .description("restart app process")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--wait", "wait for running+ready state")
    .option("--timeout <duration>", "wait timeout (e.g. 30s, 2m)")
    .action(
      async (
        appId: string,
        opts: { workspace?: string; wait?: boolean; timeout?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app restart", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          await api.apps.stopApp(appId);
          const timeout = opts.timeout ? deps.durationToMs(opts.timeout) : undefined;
          const status = opts.wait
            ? await api.apps.ensureRunning(appId, { timeout, interval: 500 })
            : await api.apps.startApp(appId);
          return {
            workspace_id: ws.project_id,
            ...status,
          };
        });
      },
    );

  app
    .command("status <appId>")
    .description("get app runtime status")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .action(
      async (
        appId: string,
        opts: { workspace?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app status", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const status = await api.apps.statusApp(appId);
          return {
            workspace_id: ws.project_id,
            ...status,
          };
        });
      },
    );

  app
    .command("logs <appId>")
    .description("show captured app stdout/stderr")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--tail <lines>", "tail lines per stream", "200")
    .action(
      async (
        appId: string,
        opts: { workspace?: string; tail?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app logs", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const data = await api.apps.appLogs(appId);
          const tail = parsePositiveIntOrThrow(opts.tail, "--tail") ?? 200;
          const takeTail = (text: string) =>
            text
              .split(/\r?\n/)
              .slice(-tail)
              .join("\n")
              .trim();
          return {
            workspace_id: ws.project_id,
            app_id: appId,
            state: data.state,
            stdout: takeTail(data.stdout ?? ""),
            stderr: takeTail(data.stderr ?? ""),
          };
        });
      },
    );

  app
    .command("expose <appId>")
    .description("enable public app access with required TTL")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .requiredOption("--ttl <duration>", "public exposure TTL (e.g. 10m, 2h)")
    .option(
      "--front-auth <mode>",
      "front auth mode: token|none (default: token)",
      "token",
    )
    .option(
      "--random-subdomain",
      "request random subdomain label metadata",
      true,
    )
    .action(
      async (
        appId: string,
        opts: {
          workspace?: string;
          ttl: string;
          frontAuth?: "token" | "none";
          randomSubdomain?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "workspace app expose", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const spec = await api.apps.getAppSpec(appId);
          const ttlMs = deps.durationToMs(opts.ttl);
          const ttl_s = Math.max(60, Math.floor(ttlMs / 1000));
          const auth_front = opts.frontAuth === "none" ? "none" : "token";
          const status = await api.apps.exposeApp({
            id: appId,
            ttl_s,
            auth_front,
            random_subdomain: opts.randomSubdomain !== false,
          });
          const relative = `/${ws.project_id}${normalizePrefix(spec.proxy?.base_path ?? `/apps/${appId}`)}`;
          const base = `${ctx.apiBaseUrl}`.replace(/\/+$/, "");
          const exposure = status.exposure;
          const url = new URL(`${base}${relative}`);
          if (auth_front === "token" && exposure?.token) {
            url.searchParams.set("cocalc_app_token", exposure.token);
          }
          return {
            workspace_id: ws.project_id,
            app_id: appId,
            ttl_s,
            relative_url: relative,
            url_public: url.toString(),
            exposure,
          };
        });
      },
    );

  app
    .command("unexpose <appId>")
    .description("disable public app access")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .action(
      async (
        appId: string,
        opts: { workspace?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app unexpose", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const status = await api.apps.unexposeApp(appId);
          return {
            workspace_id: ws.project_id,
            app_id: appId,
            exposure: status.exposure,
            state: status.state,
          };
        });
      },
    );

  app
    .command("ensure-running <appId>")
    .description("start app and wait until ready")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--timeout <duration>", "wait timeout (e.g. 30s, 2m)")
    .option("--interval-ms <ms>", "poll interval in milliseconds", "500")
    .action(
      async (
        appId: string,
        opts: {
          workspace?: string;
          timeout?: string;
          intervalMs?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "workspace app ensure-running", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const timeout = opts.timeout ? deps.durationToMs(opts.timeout) : undefined;
          const interval = parsePositiveIntOrThrow(opts.intervalMs, "--interval-ms") ?? 500;
          const status = await api.apps.ensureRunning(appId, {
            timeout,
            interval,
          });
          return {
            workspace_id: ws.project_id,
            ...status,
          };
        });
      },
    );

  app
    .command("wait <appId>")
    .description("wait for app runtime state")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .requiredOption("--state <state>", "running or stopped")
    .option("--timeout <duration>", "wait timeout (e.g. 30s, 2m)")
    .option("--interval-ms <ms>", "poll interval in milliseconds", "500")
    .action(
      async (
        appId: string,
        opts: {
          workspace?: string;
          state: string;
          timeout?: string;
          intervalMs?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "workspace app wait", async (ctx) => {
          const desired = `${opts.state}`.trim().toLowerCase();
          if (desired !== "running" && desired !== "stopped") {
            throw new Error("--state must be running or stopped");
          }
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const timeout = opts.timeout ? deps.durationToMs(opts.timeout) : undefined;
          const interval = parsePositiveIntOrThrow(opts.intervalMs, "--interval-ms") ?? 500;
          const ok = await api.apps.waitForAppState(appId, desired, {
            timeout,
            interval,
          });
          return {
            workspace_id: ws.project_id,
            app_id: appId,
            state: desired,
            reached: ok,
          };
        });
      },
    );

  app
    .command("bootstrap-example")
    .description("emit example JSON app spec")
    .action(async (_opts: Record<string, never>, command: Command) => {
      await withContext(command, "workspace app bootstrap-example", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx);
        return {
          workspace_id: ws.project_id,
          example: {
            version: 1,
            id: "my-app",
            title: "My App",
            kind: "service",
            command: {
              exec: "python3",
              args: ["-m", "http.server", "--bind", "127.0.0.1", "8000"],
            },
            network: {
              listen_host: "127.0.0.1",
              port: 8000,
              protocol: "http",
            },
            proxy: {
              base_path: "/apps/my-app",
              strip_prefix: true,
              websocket: true,
              readiness_timeout_s: 30,
            },
            wake: {
              enabled: true,
              keep_warm_s: 1800,
              startup_timeout_s: 90,
            },
          },
        };
      });
    });
}
