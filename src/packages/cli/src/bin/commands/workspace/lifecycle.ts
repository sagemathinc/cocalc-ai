/**
 * Workspace backup and service lifecycle commands.
 *
 * Focuses on backup create/list/restore flows and HTTP token/proxy checks used
 * to validate host-side workspace service reachability.
 */
import { URL } from "node:url";
import { Command } from "commander";

import type { WorkspaceCommandDeps } from "../workspace";

export function registerWorkspaceLifecycleCommands(
  workspace: Command,
  deps: WorkspaceCommandDeps,
): void {
  const {
    withContext,
    resolveWorkspaceFromArgOrContext,
    waitForLro,
    toIso,
    resolveProxyUrl,
    buildCookieHeader,
    isRedirect,
    extractCookie,
    fetchWithTimeout,
    PROJECT_HOST_HTTP_AUTH_QUERY_PARAM,
  } = deps;

const backup = workspace.command("backup").description("workspace backups");

backup
  .command("create")
  .description("create a backup (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--wait", "wait for completion")
  .action(async (opts: { workspace?: string; wait?: boolean }, command: Command) => {
    await withContext(command, "workspace backup create", async (ctx) => {
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      const op = await ctx.hub.projects.createBackup({
        project_id: ws.project_id,
      });
      if (!opts.wait) {
        return {
          workspace_id: ws.project_id,
          op_id: op.op_id,
          status: "queued",
        };
      }
      const summary = await waitForLro(ctx, op.op_id, {
        timeoutMs: ctx.timeoutMs,
        pollMs: ctx.pollMs,
      });
      if (summary.timedOut) {
        throw new Error(`backup timed out (op=${op.op_id}, last_status=${summary.status})`);
      }
      if (summary.status !== "succeeded") {
        throw new Error(`backup failed: status=${summary.status} error=${summary.error ?? "unknown"}`);
      }
      return {
        workspace_id: ws.project_id,
        op_id: op.op_id,
        status: summary.status,
      };
    });
  });

backup
  .command("list")
  .description("list backups (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--indexed-only", "only list indexed backups")
  .option("--limit <n>", "max rows", "100")
  .action(
    async (opts: { workspace?: string; indexedOnly?: boolean; limit?: string }, command: Command) => {
      await withContext(command, "workspace backup list", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const backups = (await ctx.hub.projects.getBackups({
          project_id: ws.project_id,
          indexed_only: !!opts.indexedOnly,
        })) as Array<{ id: string; time: string | Date; summary?: Record<string, any> }>;
        const limitNum = Math.max(1, Math.min(10000, Number(opts.limit ?? "100") || 100));
        return (backups ?? []).slice(0, limitNum).map((b) => ({
          workspace_id: ws.project_id,
          backup_id: b.id,
          time: toIso(b.time),
          summary: b.summary ?? null,
        }));
      });
    },
  );

backup
  .command("files")
  .description("list files for one backup (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .requiredOption("--backup-id <id>", "backup id")
  .option("--path <path>", "path inside backup")
  .action(
    async (opts: { workspace?: string; backupId: string; path?: string }, command: Command) => {
      await withContext(command, "workspace backup files", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const files = (await ctx.hub.projects.getBackupFiles({
          project_id: ws.project_id,
          id: opts.backupId,
          path: opts.path,
        })) as Array<{ name: string; isDir: boolean; mtime: number; size: number }>;
        return (files ?? []).map((f) => ({
          workspace_id: ws.project_id,
          backup_id: opts.backupId,
          name: f.name,
          is_dir: !!f.isDir,
          mtime: f.mtime,
          size: f.size,
        }));
      });
    },
  );

backup
  .command("restore")
  .description("restore backup content (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .requiredOption("--backup-id <id>", "backup id")
  .option("--path <path>", "source path in backup")
  .option("--dest <path>", "destination path in workspace")
  .option("--wait", "wait for completion")
  .action(
    async (
      opts: { workspace?: string; backupId: string; path?: string; dest?: string; wait?: boolean },
      command: Command,
    ) => {
      await withContext(command, "workspace backup restore", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const op = await ctx.hub.projects.restoreBackup({
          project_id: ws.project_id,
          id: opts.backupId,
          path: opts.path,
          dest: opts.dest,
        });
        if (!opts.wait) {
          return {
            workspace_id: ws.project_id,
            backup_id: opts.backupId,
            op_id: op.op_id,
            status: "queued",
          };
        }
        const summary = await waitForLro(ctx, op.op_id, {
          timeoutMs: ctx.timeoutMs,
          pollMs: ctx.pollMs,
        });
        if (summary.timedOut) {
          throw new Error(`restore timed out (op=${op.op_id}, last_status=${summary.status})`);
        }
        if (summary.status !== "succeeded") {
          throw new Error(`restore failed: status=${summary.status} error=${summary.error ?? "unknown"}`);
        }
        return {
          workspace_id: ws.project_id,
          backup_id: opts.backupId,
          op_id: op.op_id,
          status: summary.status,
        };
      });
    },
  );

const snapshot = workspace.command("snapshot").description("workspace snapshots");

snapshot
  .command("create")
  .description("create a btrfs snapshot (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--name <name>", "snapshot name")
  .action(async (opts: { workspace?: string; name?: string }, command: Command) => {
    await withContext(command, "workspace snapshot create", async (ctx) => {
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      await ctx.hub.projects.createSnapshot({
        project_id: ws.project_id,
        name: opts.name,
      });
      return {
        workspace_id: ws.project_id,
        snapshot_name: opts.name ?? "(auto)",
        status: "created",
      };
    });
  });

snapshot
  .command("list")
  .description("list snapshot usage (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(async (opts: { workspace?: string }, command: Command) => {
    await withContext(command, "workspace snapshot list", async (ctx) => {
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      const snapshots = await ctx.hub.projects.allSnapshotUsage({
        project_id: ws.project_id,
      });
      return snapshots.map((snap) => ({
        workspace_id: ws.project_id,
        name: snap.name,
        used: snap.used,
        exclusive: snap.exclusive,
        quota: snap.quota,
      }));
    });
  });

const proxy = workspace.command("proxy").description("workspace proxy operations");

proxy
  .command("url")
  .description("compute proxy URL for a workspace port (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .requiredOption("--port <port>", "port number")
  .option("--host <host>", "host override")
  .action(async (opts: { workspace?: string; port: string; host?: string }, command: Command) => {
      await withContext(command, "workspace proxy url", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const details = await resolveProxyUrl({
          ctx,
          workspaceIdentifier: ws.project_id,
          port: Number(opts.port),
          hostIdentifier: opts.host,
        });
        return details;
      });
    },
  );

proxy
  .command("curl")
  .description("request a workspace proxied URL (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .requiredOption("--port <port>", "port number")
  .option("--host <host>", "host override")
  .option("--path <path>", "path relative to proxied app", "/")
  .option("--token <token>", "project-host HTTP auth token")
  .option("--expect <mode>", "expected outcome: ok|denied|any", "any")
  .action(
    async (
      opts: {
        workspace?: string;
        port: string;
        host?: string;
        path?: string;
        token?: string;
        expect?: "ok" | "denied" | "any";
      },
      command: Command,
    ) => {
      await withContext(command, "workspace proxy curl", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const details = await resolveProxyUrl({
          ctx,
          workspaceIdentifier: ws.project_id,
          port: Number(opts.port),
          hostIdentifier: opts.host,
        });

        const relativePath = (opts.path ?? "/").replace(/^\/+/, "");
        const requestUrl = relativePath ? `${details.url}${relativePath}` : details.url;
        const authCookie = buildCookieHeader(ctx.apiBaseUrl, ctx.globals);

        const timeoutMs = ctx.timeoutMs;
        let response: Response;
        let finalUrl = requestUrl;

        if (opts.token) {
          const bootstrapUrl = new URL(requestUrl);
          bootstrapUrl.searchParams.set(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM, opts.token);
          const bootstrap = await fetchWithTimeout(
            bootstrapUrl.toString(),
            {
              redirect: "manual",
              ...(authCookie
                ? {
                    headers: {
                      Cookie: authCookie,
                    },
                  }
                : undefined),
            },
            timeoutMs,
          );
          response = bootstrap;
          finalUrl = bootstrapUrl.toString();

          if (isRedirect(bootstrap.status)) {
            const cookie = extractCookie(
              bootstrap.headers.get("set-cookie"),
              "cocalc_project_host_http_session",
            );
            const location = bootstrap.headers.get("location");
            if (cookie && location) {
              finalUrl = new URL(location, bootstrapUrl.toString()).toString();
              const combinedCookie = authCookie ? `${authCookie}; ${cookie}` : cookie;
              response = await fetchWithTimeout(
                finalUrl,
                {
                  headers: {
                    Cookie: combinedCookie,
                  },
                  redirect: "manual",
                },
                timeoutMs,
              );
            }
          }
        } else {
          response = await fetchWithTimeout(
            requestUrl,
            {
              redirect: "manual",
              ...(authCookie
                ? {
                    headers: {
                      Cookie: authCookie,
                    },
                  }
                : undefined),
            },
            timeoutMs,
          );
        }

        const body = await response.text();
        const expectMode = opts.expect ?? "any";
        if (expectMode === "ok" && (response.status < 200 || response.status >= 400)) {
          throw new Error(`expected success response, got status ${response.status}`);
        }
        if (expectMode === "denied" && response.status < 300) {
          throw new Error(`expected denied (non-2xx) response, got status ${response.status}`);
        }

        return {
          workspace_id: details.workspace_id,
          host_id: details.host_id,
          local_proxy: details.local_proxy,
          url: finalUrl,
          status: response.status,
          body_preview: body.slice(0, 1024),
        };
      });
    },
  );
}
