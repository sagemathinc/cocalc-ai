import { existsSync } from "node:fs";
import { Command } from "commander";

import type { WorkspaceCommandDeps } from "../workspace";

type SyncKeyInfo = any;

export function registerWorkspaceSyncCommands(
  workspace: Command,
  deps: WorkspaceCommandDeps,
): void {
  const {
    withContext,
    runLocalCommand,
    ensureSyncKeyPair,
    normalizeSyncKeyBasePath,
    syncKeyPublicPath,
    readSyncPublicKey,
    installSyncPublicKey,
    resolveWorkspaceSshTarget,
    runReflectSyncCli,
    parseCreatedForwardId,
    listReflectForwards,
    reflectSyncHomeDir,
    reflectSyncSessionDbPath,
    formatReflectForwardRow,
    forwardsForWorkspace,
    terminateReflectForwards,
  } = deps;

const sync = workspace.command("sync").description("workspace sync and forwarding operations");

const syncKey = sync.command("key").description("manage ssh keys for workspace sync");

syncKey
  .command("ensure")
  .description("ensure a local ssh keypair exists for sync/forwarding")
  .option("--key-path <path>", "ssh key base path (default: ~/.ssh/id_ed25519)")
  .action(async (opts: { keyPath?: string }, command: Command) => {
    await runLocalCommand(command, "workspace sync key ensure", async () => {
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
  .option("--key-path <path>", "ssh key base path (default: ~/.ssh/id_ed25519)")
  .action(async (opts: { keyPath?: string }, command: Command) => {
    await runLocalCommand(command, "workspace sync key show", async () => {
      const keyBasePath = normalizeSyncKeyBasePath(opts.keyPath);
      const publicKeyPath = syncKeyPublicPath(keyBasePath);
      if (!existsSync(publicKeyPath)) {
        throw new Error(
          `ssh public key not found at ${publicKeyPath}; run 'cocalc ws sync key ensure'`,
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
  .description("install a local ssh public key into workspace .ssh/authorized_keys")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--key-path <path>", "ssh key base path (default: ~/.ssh/id_ed25519)")
  .option("--no-ensure", "require key to already exist locally")
  .action(
    async (
      opts: { workspace?: string; keyPath?: string; ensure?: boolean },
      command: Command,
    ) => {
      await withContext(command, "workspace sync key install", async (ctx) => {
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
          workspaceIdentifier: opts.workspace,
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
  .description("manage workspace port forwards via reflect-sync");

syncForward
  .command("create")
  .description("forward a workspace port to localhost (reflect-sync managed)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .requiredOption("--remote-port <port>", "workspace port to expose locally")
  .option("--local-port <port>", "local port (default: same as remote port)")
  .option("--local-host <host>", "local bind host", "127.0.0.1")
  .option("--name <name>", "forward name")
  .option("--compress", "enable ssh compression")
  .option("--ensure-key", "ensure local ssh key exists before creating forward")
  .option("--install-key", "install local ssh public key into workspace before creating forward")
  .option("--key-path <path>", "ssh key base path (default: ~/.ssh/id_ed25519)")
  .action(
    async (
      opts: {
        workspace?: string;
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
      await withContext(command, "workspace sync forward create", async (ctx) => {
        const remotePort = Number(opts.remotePort);
        if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
          throw new Error("--remote-port must be an integer between 1 and 65535");
        }
        const localPort = opts.localPort == null ? remotePort : Number(opts.localPort);
        if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) {
          throw new Error("--local-port must be an integer between 1 and 65535");
        }
        const localHost = `${opts.localHost ?? "127.0.0.1"}`.trim() || "127.0.0.1";

        const target = await resolveWorkspaceSshTarget(ctx, opts.workspace);
        let keyInfo: SyncKeyInfo | null = null;
        let keyInstall: Record<string, unknown> | null = null;
        if (opts.ensureKey || opts.installKey) {
          keyInfo = await ensureSyncKeyPair(opts.keyPath);
        }
        if (opts.installKey) {
          keyInfo ??= await ensureSyncKeyPair(opts.keyPath);
          keyInstall = await installSyncPublicKey({
            ctx,
            workspaceIdentifier: target.workspace.project_id,
            publicKey: keyInfo.public_key,
          });
        }

        const remoteEndpoint = `${target.ssh_target}:${remotePort}`;
        const localEndpoint = `${localHost}:${localPort}`;
        const forwardName =
          opts.name ??
          `ws-${target.workspace.project_id.slice(0, 8)}-${remotePort}-to-${localPort}`;
        const createArgs = ["forward", "create", remoteEndpoint, localEndpoint];
        if (forwardName.trim()) {
          createArgs.push("--name", forwardName);
        }
        if (opts.compress) {
          createArgs.push("--compress");
        }
        const created = await runReflectSyncCli(createArgs);
        const createdId = parseCreatedForwardId(`${created.stdout}\n${created.stderr}`);
        const rows = await listReflectForwards();
        const createdRow =
          createdId == null ? null : rows.find((row) => Number(row.id) === createdId) ?? null;

        return {
          workspace_id: target.workspace.project_id,
          workspace_title: target.workspace.title,
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
          key_already_present: keyInstall ? keyInstall.already_present : null,
        };
      });
    },
  );

syncForward
  .command("list")
  .description("list workspace forwards managed by reflect-sync")
  .option("-w, --workspace <workspace>", "workspace id or name (defaults to context)")
  .option("--all", "list all local forwards (ignore workspace context)")
  .action(
    async (
      opts: { workspace?: string; all?: boolean },
      command: Command,
    ) => {
      if (opts.all) {
        await runLocalCommand(command, "workspace sync forward list", async () => {
          const rows = await listReflectForwards();
          return rows.map((row) => formatReflectForwardRow(row));
        });
        return;
      }
      await withContext(command, "workspace sync forward list", async (ctx) => {
        const target = await resolveWorkspaceSshTarget(ctx, opts.workspace);
        const rows = await listReflectForwards();
        return forwardsForWorkspace(rows, target.workspace.project_id).map((row) =>
          formatReflectForwardRow(row),
        );
      });
    },
  );

syncForward
  .command("terminate [forward...]")
  .alias("stop")
  .description("terminate one or more forwards")
  .option("-w, --workspace <workspace>", "workspace id or name (defaults to context)")
  .option("--all", "terminate all local forwards")
  .action(
    async (
      forwardRefs: string[],
      opts: { workspace?: string; all?: boolean },
      command: Command,
    ) => {
      const refs = (forwardRefs ?? []).map((x) => `${x}`.trim()).filter(Boolean);
      if (refs.length > 0) {
        await runLocalCommand(command, "workspace sync forward terminate", async () => {
          await terminateReflectForwards(refs);
          return {
            terminated: refs.length,
            refs,
          };
        });
        return;
      }
      if (opts.all) {
        await runLocalCommand(command, "workspace sync forward terminate", async () => {
          const rows = await listReflectForwards();
          const ids = rows.map((row) => String(row.id));
          await terminateReflectForwards(ids);
          return {
            terminated: ids.length,
            refs: ids,
            scope: "all",
          };
        });
        return;
      }
      await withContext(command, "workspace sync forward terminate", async (ctx) => {
        const target = await resolveWorkspaceSshTarget(ctx, opts.workspace);
        const rows = forwardsForWorkspace(await listReflectForwards(), target.workspace.project_id);
        const ids = rows.map((row) => String(row.id));
        await terminateReflectForwards(ids);
        return {
          workspace_id: target.workspace.project_id,
          terminated: ids.length,
          refs: ids,
        };
      });
    },
  );

}
