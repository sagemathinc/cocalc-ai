/**
 * Project sync and forwarding commands.
 *
 * Handles sync key management and reflect-sync forward lifecycle so local tools
 * can reach a project over stable tunnels.
 */
import { existsSync } from "node:fs";
import { Command } from "commander";

import type { ProjectCommandDeps } from "../project";

type SyncKeyInfo = any;

export function registerProjectSyncCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    runLocalCommand,
    ensureSyncKeyPair,
    normalizeSyncKeyBasePath,
    syncKeyPublicPath,
    readSyncPublicKey,
    installSyncPublicKey,
    resolveProjectSshTarget,
    runReflectSyncCli,
    parseCreatedForwardId,
    listReflectForwards,
    reflectSyncHomeDir,
    reflectSyncSessionDbPath,
    formatReflectForwardRow,
    forwardsForProject,
    terminateReflectForwards,
  } = deps;

  const sync = project
    .command("sync")
    .description("project sync and forwarding operations");

  const syncKey = sync
    .command("key")
    .description("manage ssh keys for project sync");

  syncKey
    .command("ensure")
    .description("ensure a local ssh keypair exists for sync/forwarding")
    .option(
      "--key-path <path>",
      "ssh key base path (default: ~/.ssh/id_ed25519)",
    )
    .action(async (opts: { keyPath?: string }, command: Command) => {
      await runLocalCommand(command, "project sync key ensure", async () => {
        const key = await ensureSyncKeyPair(opts.keyPath);
        return {
          private_key_path: key.private_key_path,
          public_key_path: key.public_key_path,
          created: key.created,
        };
      });
    });

  syncKey
    .command("show")
    .description("show the local ssh public key used for sync/forwarding")
    .option(
      "--key-path <path>",
      "ssh key base path (default: ~/.ssh/id_ed25519)",
    )
    .action(async (opts: { keyPath?: string }, command: Command) => {
      await runLocalCommand(command, "project sync key show", async () => {
        const keyBasePath = normalizeSyncKeyBasePath(opts.keyPath);
        const publicKeyPath = syncKeyPublicPath(keyBasePath);
        if (!existsSync(publicKeyPath)) {
          throw new Error(
            `ssh public key not found at ${publicKeyPath}; run 'cocalc project sync key ensure'`,
          );
        }
        return {
          public_key_path: publicKeyPath,
          public_key: readSyncPublicKey(keyBasePath),
        };
      });
    });

  syncKey
    .command("install")
    .description(
      "install a local ssh public key into project .ssh/authorized_keys",
    )
    .option("-w, --project <project>", "project id or name")
    .option(
      "--key-path <path>",
      "ssh key base path (default: ~/.ssh/id_ed25519)",
    )
    .option("--no-ensure", "require key to already exist locally")
    .action(
      async (
        opts: { project?: string; keyPath?: string; ensure?: boolean },
        command: Command,
      ) => {
        await withContext(command, "project sync key install", async (ctx) => {
          const keyBasePath = normalizeSyncKeyBasePath(opts.keyPath);
          const key =
            opts.ensure === false
              ? {
                  private_key_path: keyBasePath,
                  public_key_path: syncKeyPublicPath(keyBasePath),
                  public_key: readSyncPublicKey(keyBasePath),
                  created: false,
                }
              : await ensureSyncKeyPair(keyBasePath);
          const installed = await installSyncPublicKey({
            ctx,
            projectIdentifier: opts.project,
            publicKey: key.public_key,
          });
          return {
            ...installed,
            private_key_path: key.private_key_path,
            public_key_path: key.public_key_path,
            key_created: key.created,
          };
        });
      },
    );

  const syncForward = sync
    .command("forward")
    .description("manage project port forwards via reflect-sync");

  syncForward
    .command("create")
    .description("forward a project port to localhost (reflect-sync managed)")
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--remote-port <port>", "project port to expose locally")
    .option("--local-port <port>", "local port (default: same as remote port)")
    .option("--local-host <host>", "local bind host", "127.0.0.1")
    .option("--name <name>", "forward name")
    .option("--compress", "enable ssh compression")
    .option(
      "--ensure-key",
      "ensure local ssh key exists before creating forward",
    )
    .option(
      "--install-key",
      "install local ssh public key into project before creating forward",
    )
    .option(
      "--key-path <path>",
      "ssh key base path (default: ~/.ssh/id_ed25519)",
    )
    .action(
      async (
        opts: {
          project?: string;
          remotePort: string;
          localPort?: string;
          localHost?: string;
          name?: string;
          compress?: boolean;
          ensureKey?: boolean;
          installKey?: boolean;
          keyPath?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "project sync forward create",
          async (ctx) => {
            const remotePort = Number(opts.remotePort);
            if (
              !Number.isInteger(remotePort) ||
              remotePort <= 0 ||
              remotePort > 65535
            ) {
              throw new Error(
                "--remote-port must be an integer between 1 and 65535",
              );
            }
            const localPort =
              opts.localPort == null ? remotePort : Number(opts.localPort);
            if (
              !Number.isInteger(localPort) ||
              localPort <= 0 ||
              localPort > 65535
            ) {
              throw new Error(
                "--local-port must be an integer between 1 and 65535",
              );
            }
            const localHost =
              `${opts.localHost ?? "127.0.0.1"}`.trim() || "127.0.0.1";

            const target = await resolveProjectSshTarget(ctx, opts.project);
            let keyInfo: SyncKeyInfo | null = null;
            let keyInstall: Record<string, unknown> | null = null;
            if (opts.ensureKey || opts.installKey) {
              keyInfo = await ensureSyncKeyPair(opts.keyPath);
            }
            if (opts.installKey) {
              keyInfo ??= await ensureSyncKeyPair(opts.keyPath);
              keyInstall = await installSyncPublicKey({
                ctx,
                projectIdentifier: target.project.project_id,
                publicKey: keyInfo.public_key,
              });
            }

            const remoteEndpoint = `${target.ssh_target}:${remotePort}`;
            const localEndpoint = `${localHost}:${localPort}`;
            const forwardName =
              opts.name ??
              `project-${target.project.project_id.slice(0, 8)}-${remotePort}-to-${localPort}`;
            const createArgs = [
              "forward",
              "create",
              remoteEndpoint,
              localEndpoint,
            ];
            if (forwardName.trim()) {
              createArgs.push("--name", forwardName);
            }
            if (opts.compress) {
              createArgs.push("--compress");
            }
            const created = await runReflectSyncCli(createArgs);
            const createdId = parseCreatedForwardId(
              `${created.stdout}\n${created.stderr}`,
            );
            const rows = await listReflectForwards();
            const createdRow =
              createdId == null
                ? null
                : (rows.find((row) => Number(row.id) === createdId) ?? null);

            return {
              project_id: target.project.project_id,
              project_title: target.project.title,
              ssh_server: target.ssh_server,
              reflect_home: reflectSyncHomeDir(),
              session_db: reflectSyncSessionDbPath(),
              forward_id: createdRow?.id ?? createdId,
              name: createdRow?.name ?? forwardName,
              local: createdRow
                ? `${createdRow.local_host}:${createdRow.local_port}`
                : localEndpoint,
              remote_port: createdRow?.remote_port ?? remotePort,
              state: createdRow?.actual_state ?? "running",
              key_created: keyInfo?.created ?? null,
              key_path: keyInfo?.private_key_path ?? null,
              key_installed: keyInstall ? keyInstall.installed : null,
              key_already_present: keyInstall
                ? keyInstall.already_present
                : null,
            };
          },
        );
      },
    );

  syncForward
    .command("list")
    .description("list project forwards managed by reflect-sync")
    .option(
      "-w, --project <project>",
      "project id or name (defaults to context)",
    )
    .option("--all", "list all local forwards (ignore project context)")
    .action(
      async (opts: { project?: string; all?: boolean }, command: Command) => {
        if (opts.all) {
          await runLocalCommand(
            command,
            "project sync forward list",
            async () => {
              const rows = await listReflectForwards();
              return rows.map((row) => formatReflectForwardRow(row));
            },
          );
          return;
        }
        await withContext(command, "project sync forward list", async (ctx) => {
          const target = await resolveProjectSshTarget(ctx, opts.project);
          const rows = await listReflectForwards();
          return forwardsForProject(rows, target.project.project_id).map(
            (row) => formatReflectForwardRow(row),
          );
        });
      },
    );

  syncForward
    .command("terminate [forward...]")
    .alias("stop")
    .description("terminate one or more forwards")
    .option(
      "-w, --project <project>",
      "project id or name (defaults to context)",
    )
    .option("--all", "terminate all local forwards")
    .action(
      async (
        forwardRefs: string[],
        opts: { project?: string; all?: boolean },
        command: Command,
      ) => {
        const refs = (forwardRefs ?? [])
          .map((x) => `${x}`.trim())
          .filter(Boolean);
        if (refs.length > 0) {
          await runLocalCommand(
            command,
            "project sync forward terminate",
            async () => {
              await terminateReflectForwards(refs);
              return {
                terminated: refs.length,
                refs,
              };
            },
          );
          return;
        }
        if (opts.all) {
          await runLocalCommand(
            command,
            "project sync forward terminate",
            async () => {
              const rows = await listReflectForwards();
              const ids = rows.map((row) => String(row.id));
              await terminateReflectForwards(ids);
              return {
                terminated: ids.length,
                refs: ids,
                scope: "all",
              };
            },
          );
          return;
        }
        await withContext(
          command,
          "project sync forward terminate",
          async (ctx) => {
            const target = await resolveProjectSshTarget(ctx, opts.project);
            const rows = forwardsForProject(
              await listReflectForwards(),
              target.project.project_id,
            );
            const ids = rows.map((row) => String(row.id));
            await terminateReflectForwards(ids);
            return {
              project_id: target.project.project_id,
              terminated: ids.length,
              refs: ids,
            };
          },
        );
      },
    );
}
