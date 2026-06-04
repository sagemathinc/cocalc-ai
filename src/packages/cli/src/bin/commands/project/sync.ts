/**
 * Project sync and forwarding commands.
 *
 * Handles sync key management and reflect-sync forward lifecycle so local tools
 * can reach a project over stable tunnels.
 */
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Command } from "commander";
import { DatabaseSync } from "node:sqlite";

import { decode as decodeConatPayload } from "@cocalc/conat/core/codec";
import type { ProjectCommandDeps } from "../project";

type SyncKeyInfo = any;

type PersistMessageRow = {
  seq: number;
  key?: string | null;
  time: number;
  headers?: string | null;
  compress: number;
  encoding: number;
  raw: Uint8Array;
  size: number;
  ttl?: number | null;
};

type DecodedPersistMessage = {
  type: "message";
  seq: number;
  key?: string | null;
  time: number;
  date: string;
  headers?: unknown;
  compress: number;
  encoding: number;
  raw_bytes: number;
  decoded_bytes: number;
  ttl?: number | null;
  value?: unknown;
  decode_error?: string;
};

function parseNonNegativeInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return n;
}

function parsePositiveInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

function parseJsonField(value: string | null | undefined): unknown {
  if (value == null || value === "") return undefined;
  return JSON.parse(value);
}

function decodePersistRaw(row: PersistMessageRow): Buffer {
  const raw = Buffer.from(row.raw);
  if (row.compress === 0) return raw;
  if (row.compress === 1) return Buffer.from(zstdDecompressSync(raw));
  throw new Error(`unknown compression algorithm ${row.compress}`);
}

function decodePersistMessage(row: PersistMessageRow): DecodedPersistMessage {
  const raw = decodePersistRaw(row);
  const base: DecodedPersistMessage = {
    type: "message",
    seq: row.seq,
    key: row.key,
    time: row.time,
    date: new Date(row.time * 1000).toISOString(),
    headers: parseJsonField(row.headers),
    compress: row.compress,
    encoding: row.encoding,
    raw_bytes: Buffer.from(row.raw).length,
    decoded_bytes: row.size,
    ttl: row.ttl,
  };
  try {
    base.value = decodeConatPayload({ encoding: row.encoding, data: raw });
  } catch (err) {
    base.decode_error = `${err}`;
  }
  return base;
}

function summarizeDecodedMessage(decoded: DecodedPersistMessage) {
  const value = decoded.value as any;
  return {
    seq: decoded.seq,
    time: decoded.time,
    date: decoded.date,
    key: decoded.key,
    compress: decoded.compress,
    encoding: decoded.encoding,
    raw_bytes: decoded.raw_bytes,
    decoded_bytes: decoded.decoded_bytes,
    is_snapshot: value?.is_snapshot === true,
    patch_time: typeof value?.time === "string" ? value.time : undefined,
    snapshot_bytes:
      typeof value?.snapshot === "string" ? value.snapshot.length : undefined,
    seq_info: value?.seq_info,
    headers: decoded.headers,
    decode_error: decoded.decode_error,
  };
}

function maybeSnapshotInfo(decoded: DecodedPersistMessage) {
  const value = decoded.value as any;
  if (value?.is_snapshot !== true) return undefined;
  return {
    db_seq: decoded.seq,
    time: decoded.time,
    date: decoded.date,
    patch_id: value.time,
    snapshot_bytes:
      typeof value.snapshot === "string" ? value.snapshot.length : undefined,
    seq_info: value.seq_info,
  };
}

function decodeSyncDatabase({
  dbPath,
  jsonlOutput,
  limit,
  fromSeq,
}: {
  dbPath: string;
  jsonlOutput?: string;
  limit?: number;
  fromSeq?: number;
}) {
  const filename = resolve(dbPath);
  if (!existsSync(filename)) {
    throw new Error(`database does not exist: ${filename}`);
  }
  const db = new DatabaseSync(filename, { readOnly: true });
  let outputFd: number | undefined;
  const writeJsonl = (obj: unknown) => {
    if (outputFd != null) {
      writeSync(outputFd, `${JSON.stringify(obj)}\n`);
    }
  };
  try {
    const full = db
      .prepare(
        "SELECT count(*) AS rows, min(seq) AS min_seq, max(seq) AS max_seq, sum(length(raw)) AS raw_bytes, sum(size) AS decoded_bytes FROM messages",
      )
      .get() as any;
    const compress = db
      .prepare(
        "SELECT compress, count(*) AS rows, sum(length(raw)) AS raw_bytes, sum(size) AS decoded_bytes FROM messages GROUP BY compress ORDER BY compress",
      )
      .all();
    const checkpoints = db
      .prepare(
        "SELECT name, seq, time, data_json, revision FROM stream_checkpoints ORDER BY name",
      )
      .all()
      .map((row: any) => ({
        name: row.name,
        seq: row.seq,
        time: row.time,
        data: parseJsonField(row.data_json),
        revision: row.revision,
      }));
    const metadata = db
      .prepare(
        "SELECT metadata_json, revision FROM stream_metadata WHERE id = 1",
      )
      .get() as any;
    const config = db
      .prepare("SELECT field, value FROM config ORDER BY field")
      .all();

    const snapshotRows: ReturnType<typeof maybeSnapshotInfo>[] = [];
    let decodedRows = 0;
    let decodeErrors = 0;
    let query =
      "SELECT seq, key, time, headers, compress, encoding, raw, size, ttl FROM messages";
    const params: any[] = [];
    if (fromSeq != null) {
      query += " WHERE seq >= ?";
      params.push(fromSeq);
    }
    query += " ORDER BY seq";
    if (limit != null) {
      query += " LIMIT ?";
      params.push(limit);
    }

    if (jsonlOutput != null) {
      outputFd = openSync(resolve(jsonlOutput), "w");
      writeJsonl({
        type: "database",
        path: filename,
        generated_at: new Date().toISOString(),
      });
      writeJsonl({ type: "config", rows: config });
      writeJsonl({
        type: "metadata",
        revision: metadata?.revision,
        value: parseJsonField(metadata?.metadata_json),
      });
      for (const checkpoint of checkpoints) {
        writeJsonl({ type: "checkpoint", ...checkpoint });
      }
    }

    for (const row of db.prepare(query).iterate(...params) as Iterable<any>) {
      const decoded = decodePersistMessage(row as PersistMessageRow);
      decodedRows += 1;
      if (decoded.decode_error != null) decodeErrors += 1;
      const snapshot = maybeSnapshotInfo(decoded);
      if (snapshot != null) snapshotRows.push(snapshot);
      writeJsonl(
        jsonlOutput != null ? decoded : summarizeDecodedMessage(decoded),
      );
    }

    const scanIsLimited = limit != null;
    const latestSnapshot = snapshotRows[snapshotRows.length - 1];
    const expectedLatestSnapshotCheckpoint =
      scanIsLimited || latestSnapshot?.seq_info?.seq == null
        ? undefined
        : {
            name: "latest_snapshot",
            seq: latestSnapshot.seq_info.seq,
            data: { patchId: latestSnapshot.patch_id },
          };
    let fromLatestSnapshot:
      | {
          rows: number;
          raw_bytes: number;
          decoded_bytes: number;
          min_seq?: number;
          max_seq?: number;
        }
      | undefined;
    if (expectedLatestSnapshotCheckpoint?.seq != null) {
      fromLatestSnapshot = db
        .prepare(
          "SELECT count(*) AS rows, min(seq) AS min_seq, max(seq) AS max_seq, sum(length(raw)) AS raw_bytes, sum(size) AS decoded_bytes FROM messages WHERE seq >= ?",
        )
        .get(expectedLatestSnapshotCheckpoint.seq) as any;
    }

    const summary = {
      path: filename,
      messages: {
        rows: full.rows,
        min_seq: full.min_seq,
        max_seq: full.max_seq,
        raw_bytes: full.raw_bytes ?? 0,
        decoded_bytes: full.decoded_bytes ?? 0,
        compression: compress,
      },
      decoded_scan: {
        rows: decodedRows,
        from_seq: fromSeq,
        limit,
        limited: scanIsLimited,
        decode_errors: decodeErrors,
      },
      metadata: {
        revision: metadata?.revision,
        value: parseJsonField(metadata?.metadata_json),
      },
      checkpoints,
      snapshots: {
        rows: snapshotRows.length,
        first: snapshotRows[0],
        latest: latestSnapshot,
        expected_latest_snapshot_checkpoint: expectedLatestSnapshotCheckpoint,
        from_latest_snapshot: fromLatestSnapshot,
      },
      jsonl_output: jsonlOutput == null ? undefined : resolve(jsonlOutput),
    };
    writeJsonl({ type: "summary", ...summary });
    return summary;
  } finally {
    if (outputFd != null) {
      closeSync(outputFd);
    }
    db.close();
  }
}

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

  sync
    .command("decode-db <database>")
    .description("decode a local Conat sync/persist sqlite database")
    .option(
      "--jsonl-output <file>",
      "write decoded message records as JSONL to this file",
    )
    .option("--from-seq <seq>", "only scan messages at or after this seq")
    .option("--limit <n>", "maximum number of messages to decode")
    .action(
      async (
        database: string,
        opts: { jsonlOutput?: string; fromSeq?: string; limit?: string },
        command: Command,
      ) => {
        await runLocalCommand(command, "project sync decode-db", async () =>
          decodeSyncDatabase({
            dbPath: database,
            jsonlOutput: opts.jsonlOutput,
            fromSeq: parseNonNegativeInteger(opts.fromSeq, "--from-seq"),
            limit: parsePositiveInteger(opts.limit, "--limit"),
          }),
        );
      },
    );

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
