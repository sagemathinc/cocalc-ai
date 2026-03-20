/**
 * Project backup and service lifecycle commands.
 *
 * Focuses on backup create/list/restore flows and HTTP token/proxy checks used
 * to validate host-side project service reachability.
 */
import { URL } from "node:url";
import { Command } from "commander";

import type { ProjectCommandDeps } from "../project";

export function registerProjectLifecycleCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    resolveProjectFromArgOrContext,
    waitForLro,
    toIso,
    resolveProxyUrl,
    buildCookieHeader,
    isRedirect,
    extractCookie,
    fetchWithTimeout,
    PROJECT_HOST_HTTP_AUTH_QUERY_PARAM,
  } = deps;

  const backup = project.command("backup").description("project backups");

  backup
    .command("create")
    .description("create a backup (defaults to context)")
    .option("-w, --project <project>", "project id or name")
    .option("--wait", "wait for completion")
    .action(
      async (opts: { project?: string; wait?: boolean }, command: Command) => {
        await withContext(command, "project backup create", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const op = await ctx.hub.projects.createBackup({
            project_id: ws.project_id,
          });
          if (!opts.wait) {
            return {
              project_id: ws.project_id,
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
              `backup timed out (op=${op.op_id}, last_status=${summary.status})`,
            );
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `backup failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }
          return {
            project_id: ws.project_id,
            op_id: op.op_id,
            status: summary.status,
          };
        });
      },
    );

  backup
    .command("list")
    .description("list backups (defaults to context)")
    .option("-w, --project <project>", "project id or name")
    .option("--indexed-only", "only list indexed backups")
    .option("--limit <n>", "max rows", "100")
    .action(
      async (
        opts: { project?: string; indexedOnly?: boolean; limit?: string },
        command: Command,
      ) => {
        await withContext(command, "project backup list", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const backups = (await ctx.hub.projects.getBackups({
            project_id: ws.project_id,
            indexed_only: !!opts.indexedOnly,
          })) as Array<{
            id: string;
            time: string | Date;
            summary?: Record<string, any>;
          }>;
          const limitNum = Math.max(
            1,
            Math.min(10000, Number(opts.limit ?? "100") || 100),
          );
          return (backups ?? []).slice(0, limitNum).map((b) => ({
            project_id: ws.project_id,
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
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--backup-id <id>", "backup id")
    .option("--path <path>", "path inside backup")
    .action(
      async (
        opts: { project?: string; backupId: string; path?: string },
        command: Command,
      ) => {
        await withContext(command, "project backup files", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const files = (await ctx.hub.projects.getBackupFiles({
            project_id: ws.project_id,
            id: opts.backupId,
            path: opts.path,
          })) as Array<{
            name: string;
            isDir: boolean;
            mtime: number;
            size: number;
          }>;
          return (files ?? []).map((f) => ({
            project_id: ws.project_id,
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
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--backup-id <id>", "backup id")
    .option("--path <path>", "source path in backup")
    .option("--dest <path>", "destination path in project")
    .option("--wait", "wait for completion")
    .action(
      async (
        opts: {
          project?: string;
          backupId: string;
          path?: string;
          dest?: string;
          wait?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project backup restore", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const op = await ctx.hub.projects.restoreBackup({
            project_id: ws.project_id,
            id: opts.backupId,
            path: opts.path,
            dest: opts.dest,
          });
          if (!opts.wait) {
            return {
              project_id: ws.project_id,
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
            throw new Error(
              `restore timed out (op=${op.op_id}, last_status=${summary.status})`,
            );
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `restore failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }
          return {
            project_id: ws.project_id,
            backup_id: opts.backupId,
            op_id: op.op_id,
            status: summary.status,
          };
        });
      },
    );

  const snapshot = project.command("snapshot").description("project snapshots");

  snapshot
    .command("create")
    .description("create a btrfs snapshot (defaults to context)")
    .option("-w, --project <project>", "project id or name")
    .option("--name <name>", "snapshot name")
    .action(
      async (opts: { project?: string; name?: string }, command: Command) => {
        await withContext(command, "project snapshot create", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          await ctx.hub.projects.createSnapshot({
            project_id: ws.project_id,
            name: opts.name,
          });
          return {
            project_id: ws.project_id,
            snapshot_name: opts.name ?? "(auto)",
            status: "created",
          };
        });
      },
    );

  snapshot
    .command("list")
    .description("list snapshot usage (defaults to context)")
    .option("-w, --project <project>", "project id or name")
    .action(async (opts: { project?: string }, command: Command) => {
      await withContext(command, "project snapshot list", async (ctx) => {
        const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
        const snapshots = await ctx.hub.projects.allSnapshotUsage({
          project_id: ws.project_id,
        });
        return snapshots.map((snap) => ({
          project_id: ws.project_id,
          name: snap.name,
          used: snap.used,
          exclusive: snap.exclusive,
          quota: snap.quota,
        }));
      });
    });

  snapshot
    .command("restore")
    .description(
      "fully restore a project from a snapshot (defaults to context)",
    )
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--snapshot <name>", "snapshot name")
    .option("--mode <mode>", "what to restore: both, home, or rootfs", "both")
    .option(
      "--safety-snapshot-name <name>",
      "name for the automatic pre-restore safety snapshot",
    )
    .option("--wait", "wait for completion")
    .action(
      async (
        opts: {
          project?: string;
          snapshot: string;
          mode?: string;
          safetySnapshotName?: string;
          wait?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project snapshot restore", async (ctx) => {
          const mode = `${opts.mode ?? "both"}`.trim() as
            | "both"
            | "home"
            | "rootfs";
          if (!["both", "home", "rootfs"].includes(mode)) {
            throw new Error(`invalid snapshot restore mode: ${opts.mode}`);
          }
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const op = await ctx.hub.projects.restoreSnapshot({
            project_id: ws.project_id,
            snapshot: opts.snapshot,
            mode,
            safety_snapshot_name: opts.safetySnapshotName,
          });
          if (!opts.wait) {
            return {
              project_id: ws.project_id,
              snapshot: opts.snapshot,
              mode,
              safety_snapshot_name: opts.safetySnapshotName ?? "(auto)",
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
              `snapshot restore timed out (op=${op.op_id}, last_status=${summary.status})`,
            );
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `snapshot restore failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }
          return {
            project_id: ws.project_id,
            snapshot: opts.snapshot,
            mode,
            safety_snapshot_name:
              summary.result?.safety_snapshot_name ??
              opts.safetySnapshotName ??
              "(auto)",
            op_id: op.op_id,
            status: summary.status,
          };
        });
      },
    );

  const proxy = project
    .command("proxy")
    .description("project proxy operations");

  proxy
    .command("url")
    .description("compute proxy URL for a project port (defaults to context)")
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--port <port>", "port number")
    .option("--host <host>", "host override")
    .action(
      async (
        opts: { project?: string; port: string; host?: string },
        command: Command,
      ) => {
        await withContext(command, "project proxy url", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const details = await resolveProxyUrl({
            ctx,
            projectIdentifier: ws.project_id,
            port: Number(opts.port),
            hostIdentifier: opts.host,
          });
          return details;
        });
      },
    );

  proxy
    .command("curl")
    .description("request a project proxied URL (defaults to context)")
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--port <port>", "port number")
    .option("--host <host>", "host override")
    .option("--path <path>", "path relative to proxied app", "/")
    .option("--token <token>", "project-host HTTP auth token")
    .option("--expect <mode>", "expected outcome: ok|denied|any", "any")
    .action(
      async (
        opts: {
          project?: string;
          port: string;
          host?: string;
          path?: string;
          token?: string;
          expect?: "ok" | "denied" | "any";
        },
        command: Command,
      ) => {
        await withContext(command, "project proxy curl", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const details = await resolveProxyUrl({
            ctx,
            projectIdentifier: ws.project_id,
            port: Number(opts.port),
            hostIdentifier: opts.host,
          });

          const relativePath = (opts.path ?? "/").replace(/^\/+/, "");
          const requestUrl = relativePath
            ? `${details.url}${relativePath}`
            : details.url;
          const authCookie = buildCookieHeader(ctx.apiBaseUrl, ctx.globals);

          const timeoutMs = ctx.timeoutMs;
          let response: Response;
          let finalUrl = requestUrl;

          if (opts.token) {
            const bootstrapUrl = new URL(requestUrl);
            bootstrapUrl.searchParams.set(
              PROJECT_HOST_HTTP_AUTH_QUERY_PARAM,
              opts.token,
            );
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
                finalUrl = new URL(
                  location,
                  bootstrapUrl.toString(),
                ).toString();
                const combinedCookie = authCookie
                  ? `${authCookie}; ${cookie}`
                  : cookie;
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
          if (
            expectMode === "ok" &&
            (response.status < 200 || response.status >= 400)
          ) {
            throw new Error(
              `expected success response, got status ${response.status}`,
            );
          }
          if (expectMode === "denied" && response.status < 300) {
            throw new Error(
              `expected denied (non-2xx) response, got status ${response.status}`,
            );
          }

          return {
            project_id: details.project_id,
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
