import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { Command } from "commander";

export type DevCommandDeps = {
  runLocalCommand: any;
  withContext: any;
  resolveHost: any;
  resolveWorkspaceFromArgOrContext: any;
  waitForLro: any;
};

type CommandCapture = {
  code: number;
  stdout: string;
  stderr: string;
};

function cliPackageRoot(): string {
  return resolve(__dirname, "../../../..");
}

function repoSrcRoot(): string {
  return resolve(cliPackageRoot(), "../..");
}

function artifactSummary(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
    };
  }
  const stat = statSync(path);
  return {
    path,
    exists: true,
    size_bytes: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

async function runCapture(
  command: string,
  args: string[],
  cwd: string,
): Promise<CommandCapture> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function tailLines(value: string, count = 20): string {
  const lines = `${value ?? ""}`.trimEnd().split(/\r?\n/);
  if (lines.length <= count) {
    return lines.join("\n");
  }
  return lines.slice(-count).join("\n");
}

async function runOrThrow(
  command: string,
  args: string[],
  cwd: string,
): Promise<CommandCapture> {
  const result = await runCapture(command, args, cwd);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      detail || `${command} ${args.join(" ")} exited with code ${result.code}`,
    );
  }
  return result;
}

function hubSoftwareBaseUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/software`;
}

function resolveUpgradeTarget(opts: {
  host?: string;
  workspace?: string;
}): { hostIdentifier?: string; workspaceIdentifier?: string } {
  const hostIdentifier = `${opts.host ?? ""}`.trim() || undefined;
  const workspaceIdentifier = `${opts.workspace ?? ""}`.trim() || undefined;
  if (!hostIdentifier && !workspaceIdentifier) {
    throw new Error("specify either --host or --workspace");
  }
  return { hostIdentifier, workspaceIdentifier };
}

function buildCommandSummary(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

async function buildLocalArtifact({
  label,
  cwd,
  command,
  args,
  artifactPath,
}: {
  label: string;
  cwd: string;
  command: string;
  args: string[];
  artifactPath: string;
}): Promise<Record<string, unknown>> {
  const build = await runOrThrow(command, args, cwd);
  return {
    label,
    command: buildCommandSummary(command, args),
    stdout_tail: tailLines(build.stdout),
    stderr_tail: tailLines(build.stderr),
    artifact: artifactSummary(artifactPath),
  };
}

export function registerDevCommand(program: Command, deps: DevCommandDeps): Command {
  const {
    runLocalCommand,
    withContext,
    resolveHost,
    resolveWorkspaceFromArgOrContext,
    waitForLro,
  } = deps;

  const dev = program.command("dev").description("developer workflow commands");
  const sync = dev.command("sync").description("build and deploy changed runtime layers");

  sync
    .command("hub")
    .description("rebuild the hub package and restart the local hub daemon")
    .option("--no-build", "skip pnpm build for packages/hub")
    .option("--no-restart", "skip restarting hub-daemon")
    .action(
      async (
        opts: { build?: boolean; restart?: boolean },
        command: Command,
      ) => {
        await runLocalCommand(command, "dev sync hub", async () => {
          const srcRoot = repoSrcRoot();
          const packageRoot = join(srcRoot, "packages", "hub");
          const daemonScript = join(srcRoot, "scripts", "dev", "hub-daemon.sh");
          const steps: Record<string, unknown>[] = [];

          if (opts.build !== false) {
            const built = await runOrThrow("pnpm", ["--dir", packageRoot, "build"], srcRoot);
            steps.push({
              step: "build",
              command: `pnpm --dir ${packageRoot} build`,
              stdout_tail: tailLines(built.stdout),
              stderr_tail: tailLines(built.stderr),
              package_json_version:
                JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version ?? null,
            });
          }

          if (opts.restart !== false) {
            const restarted = await runOrThrow("bash", [daemonScript, "restart"], srcRoot);
            steps.push({
              step: "restart",
              command: `bash ${daemonScript} restart`,
              stdout_tail: tailLines(restarted.stdout),
              stderr_tail: tailLines(restarted.stderr),
            });
          }

          return {
            src_root: srcRoot,
            package_root: packageRoot,
            steps,
          };
        });
      },
    );

  sync
    .command("project-host")
    .description("build the local project-host bundle and roll it out to a host")
    .option("--host <host>", "host id or name")
    .option("-w, --workspace <workspace>", "workspace id or name (to infer the host)")
    .option("--channel <channel>", "software channel: latest or staging", "latest")
    .option("--version <version>", "explicit version override")
    .option("--no-build", "skip local bundle build")
    .option("--no-wait", "queue the rollout without waiting")
    .action(
      async (
        opts: {
          host?: string;
          workspace?: string;
          channel?: string;
          version?: string;
          build?: boolean;
          wait?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "dev sync project-host", async (ctx) => {
          const srcRoot = repoSrcRoot();
          const bundlePath = join(
            srcRoot,
            "packages",
            "project-host",
            "build",
            "bundle-linux.tar.xz",
          );
          const target = resolveUpgradeTarget(opts);
          const workspace = target.workspaceIdentifier
            ? await resolveWorkspaceFromArgOrContext(ctx, target.workspaceIdentifier)
            : undefined;
          const host = await resolveHost(
            ctx,
            target.hostIdentifier ?? `${workspace?.host_id ?? ""}`,
          );
          const steps: Record<string, unknown>[] = [];

          if (opts.build !== false) {
            steps.push(
              await buildLocalArtifact({
                label: "project-host bundle",
                cwd: srcRoot,
                command: "pnpm",
                args: ["--dir", join(srcRoot, "packages", "project-host"), "build:bundle"],
                artifactPath: bundlePath,
              }),
            );
          }

          const channelRaw = `${opts.channel ?? "latest"}`.trim().toLowerCase();
          if (channelRaw !== "latest" && channelRaw !== "staging") {
            throw new Error("--channel must be one of: latest, staging");
          }
          const targetSpec = opts.version?.trim()
            ? { artifact: "project-host" as const, version: opts.version.trim() }
            : { artifact: "project-host" as const, channel: channelRaw as "latest" | "staging" };

          const op = await ctx.hub.hosts.upgradeHostSoftware({
            id: host.id,
            targets: [targetSpec],
            base_url: hubSoftwareBaseUrl(ctx.apiBaseUrl),
          });

          if (opts.wait === false) {
            return {
              host_id: host.id,
              workspace_id: workspace?.project_id ?? null,
              queued: true,
              op_id: op.op_id,
              target: targetSpec,
              steps,
            };
          }

          const summary = await waitForLro(ctx, op.op_id, {
            timeoutMs: ctx.timeoutMs,
            pollMs: ctx.pollMs,
          });
          if (summary.timedOut) {
            throw new Error(
              `project-host rollout timed out (op=${op.op_id}, last_status=${summary.status})`,
            );
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `project-host rollout failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }

          const refreshed = await resolveHost(ctx, host.id);
          return {
            host_id: host.id,
            workspace_id: workspace?.project_id ?? null,
            op_id: op.op_id,
            status: summary.status,
            target: targetSpec,
            deployed_version: refreshed.version ?? null,
            steps,
          };
        });
      },
    );

  sync
    .command("project")
    .description("build the local project bundle and roll it out to a workspace host")
    .option("--host <host>", "host id or name")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--channel <channel>", "software channel: latest or staging", "latest")
    .option("--version <version>", "explicit version override")
    .option("--no-build", "skip local bundle build")
    .option("--no-wait", "queue the rollout without waiting")
    .option("--no-restart-workspace", "do not restart the target workspace after rollout")
    .action(
      async (
        opts: {
          host?: string;
          workspace?: string;
          channel?: string;
          version?: string;
          build?: boolean;
          wait?: boolean;
          restartWorkspace?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "dev sync project", async (ctx) => {
          const srcRoot = repoSrcRoot();
          const bundlePath = join(
            srcRoot,
            "packages",
            "project",
            "build",
            "bundle-linux.tar.xz",
          );
          const target = resolveUpgradeTarget(opts);
          const workspace = target.workspaceIdentifier
            ? await resolveWorkspaceFromArgOrContext(ctx, target.workspaceIdentifier)
            : undefined;
          const host = await resolveHost(
            ctx,
            target.hostIdentifier ?? `${workspace?.host_id ?? ""}`,
          );
          const steps: Record<string, unknown>[] = [];

          if (opts.build !== false) {
            steps.push(
              await buildLocalArtifact({
                label: "project bundle",
                cwd: srcRoot,
                command: "pnpm",
                args: ["--dir", join(srcRoot, "packages", "project"), "build:bundle"],
                artifactPath: bundlePath,
              }),
            );
          }

          const channelRaw = `${opts.channel ?? "latest"}`.trim().toLowerCase();
          if (channelRaw !== "latest" && channelRaw !== "staging") {
            throw new Error("--channel must be one of: latest, staging");
          }
          const targetSpec = opts.version?.trim()
            ? { artifact: "project" as const, version: opts.version.trim() }
            : { artifact: "project" as const, channel: channelRaw as "latest" | "staging" };

          const op = await ctx.hub.hosts.upgradeHostSoftware({
            id: host.id,
            targets: [targetSpec],
            base_url: hubSoftwareBaseUrl(ctx.apiBaseUrl),
          });

          if (opts.wait === false) {
            return {
              host_id: host.id,
              workspace_id: workspace?.project_id ?? null,
              queued: true,
              op_id: op.op_id,
              target: targetSpec,
              note:
                workspace && opts.restartWorkspace !== false
                  ? "workspace restart is skipped when --no-wait is used"
                  : null,
              steps,
            };
          }

          const summary = await waitForLro(ctx, op.op_id, {
            timeoutMs: ctx.timeoutMs,
            pollMs: ctx.pollMs,
          });
          if (summary.timedOut) {
            throw new Error(
              `project bundle rollout timed out (op=${op.op_id}, last_status=${summary.status})`,
            );
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `project bundle rollout failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }

          let restartResult: Record<string, unknown> | null = null;
          if (workspace && opts.restartWorkspace !== false) {
            await ctx.hub.projects.stop({
              project_id: workspace.project_id,
            });
            const restart = await ctx.hub.projects.start({
              project_id: workspace.project_id,
              wait: false,
            });
            const restartSummary = await waitForLro(ctx, restart.op_id, {
              timeoutMs: ctx.timeoutMs,
              pollMs: ctx.pollMs,
            });
            if (restartSummary.timedOut) {
              throw new Error(
                `workspace restart timed out after project rollout (op=${restart.op_id}, last_status=${restartSummary.status})`,
              );
            }
            if (restartSummary.status !== "succeeded") {
              throw new Error(
                `workspace restart failed after project rollout: status=${restartSummary.status} error=${restartSummary.error ?? "unknown"}`,
              );
            }
            restartResult = {
              op_id: restart.op_id,
              status: restartSummary.status,
            };
          }

          const refreshed = await resolveHost(ctx, host.id);
          return {
            host_id: host.id,
            workspace_id: workspace?.project_id ?? null,
            op_id: op.op_id,
            status: summary.status,
            target: targetSpec,
            deployed_project_bundle_version: refreshed.project_bundle_version ?? null,
            workspace_restart: restartResult,
            steps,
          };
        });
      },
    );

  return dev;
}
