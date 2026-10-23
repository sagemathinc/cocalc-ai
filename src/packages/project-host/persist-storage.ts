/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A project's edit history and logs, as its users manage them: listing what the
streams in its persist volume (persist-volume.ts) take, and deleting or
trimming them to free space (conat/project/persist-storage.ts has the types;
the hub checks who may, server conat/api/project-persist-storage.ts).

The volume is host-only, so its users can't do that themselves.

- Listing reads only file sizes and sqlite headers: it opens no database.
- Deleting and trimming happen while the project's streams are closed and
  fenced (#1261), so nothing writes to a database as it changes. Open copies
  of the documents reload afterwards (the fence replaces their streams).
- Deleting removes the files, so the space comes back at once.
- Trimming removes entries through the persist storage (as its server would),
  then compacts the database.
*/

import { DatabaseSync } from "node:sqlite";
import { lstat, lutimes, open, opendir, rmdir, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import getLogger from "@cocalc/backend/logger";
// (initialized with node:sqlite, as in the persist server)
import { pstream } from "@cocalc/backend/conat/persist";
import { projectPersistTemplates } from "@cocalc/backend/conat/persist-volume-template";
import {
  MAX_PERSIST_STORAGE_ACTIONS,
  RETENTION_POLICY_KINDS,
  retentionPolicyApplies,
  type PersistStorageAction,
  type PersistStorageActionResult,
  type PersistStorageApplyResult,
  type PersistStorageList,
  type PersistStorageTotals,
  type PersistStreamInfo,
  type PersistStreamKind,
} from "@cocalc/conat/project/persist-storage";
import { isValidUUID } from "@cocalc/util/misc";
import {
  isPersistVolumeReady,
  persistVolumePath,
  withProjectStorageFenced,
} from "./persist-volume";

const logger = getLogger("project-host:persist-storage");

// Bounds a walk of a volume (its streams are named for the project's paths).
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;
const MAX_NAME_LENGTH = 4096;
// purgeArchivedHistory removes a bounded amount per call
const MAX_ARCHIVE_PURGE_STEPS = 10_000;

const SUFFIXES = ["", "-wal", "-shm", "-journal"];

// touchDocumentsWithHistory
const TOUCH_MARGIN_MS = 2_000;

// Where the project's documents are, as its streams name them.
const PROJECT_HOME_IN_NAMES = "home/user/";

function classify(name: string): {
  kind: PersistStreamKind;
  document?: string;
} {
  const slash = name.indexOf("/");
  if (slash == -1) return { kind: "project" };
  const first = name.slice(0, slash);
  const rest = name.slice(slash + 1);
  const kind: PersistStreamKind | undefined =
    first == "patchflow"
      ? "edit-history"
      : first == "acp-log"
        ? "agent-log"
        : first == "jupyter"
          ? "notebook"
          : undefined;
  if (kind == null) return { kind: "other" };
  return { kind, document: `/${rest}` };
}

// Whether `relative` exists in the project's home, never following a symlink
// (the home is the project's); undefined if that can't be told.
async function existsInHome(
  home: string,
  document: string,
): Promise<boolean | undefined> {
  const prefix = `/${PROJECT_HOME_IN_NAMES}`;
  if (!document.startsWith(prefix)) return;
  const parts = document.slice(prefix.length).split("/");
  let path = home;
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]);
    let stat;
    try {
      stat = await lstat(path);
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code == "ENOENT"
        ? false
        : undefined;
    }
    if (i < parts.length - 1 && !stat.isDirectory()) {
      // a symlink (or a file) on the way: not looked through
      return stat.isSymbolicLink() ? undefined : false;
    }
  }
  return true;
}

async function sizeOf(path: string): Promise<number> {
  try {
    const stat = await lstat(path);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

// The free pages of a database, from its header (SQLite file format §1.3):
// what a compaction gives back.  0 if it can't be read.
export async function sqliteFreeBytes(path: string): Promise<number> {
  let handle;
  try {
    handle = await open(path, "r");
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, 100, 0);
    if (
      bytesRead < 100 ||
      header.toString("latin1", 0, 15) != "SQLite format 3"
    ) {
      return 0;
    }
    const raw = header.readUInt16BE(16);
    const pageSize = raw == 1 ? 65536 : raw;
    return pageSize * header.readUInt32BE(36);
  } catch {
    return 0;
  } finally {
    await handle?.close().catch(() => {});
  }
}

interface Context {
  project_id: string;
  // the persist volume
  root: string;
  // the project's home
  home: string;
}

function context(
  project_id: string,
  env: NodeJS.ProcessEnv,
): Context | undefined {
  if (!isValidUUID(project_id)) {
    throw new Error(`invalid project id: ${project_id}`);
  }
  const root = persistVolumePath(project_id, env);
  const { legacy } = projectPersistTemplates(env);
  if (root == null || legacy == null) return;
  return {
    project_id,
    root,
    home: legacy.home.split("[project_id]").join(project_id),
  };
}

// The streams in the volume: name, sizes and time, without opening any.
async function walk(root: string): Promise<{
  streams: {
    name: string;
    bytes: number;
    reclaimable: number;
    modified: number;
  }[];
  truncated: boolean;
}> {
  const streams: {
    name: string;
    bytes: number;
    reclaimable: number;
    modified: number;
  }[] = [];
  let entries = 0;
  let truncated = false;
  const visit = async (dir: string, depth: number) => {
    let handle;
    try {
      handle = await opendir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code == "ENOENT") return;
      throw err;
    }
    for await (const entry of handle) {
      if (++entries > MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await visit(path, depth + 1);
        else truncated = true;
      } else if (entry.isFile() && entry.name.endsWith(".db")) {
        const stat = await lstat(path).catch(() => undefined);
        if (!stat?.isFile()) continue;
        let bytes = stat.size;
        let modified = stat.mtimeMs;
        for (const suffix of ["-wal", "-shm"]) {
          const extra = await lstat(path + suffix).catch(() => undefined);
          if (extra?.isFile()) {
            bytes += extra.size;
            modified = Math.max(modified, extra.mtimeMs);
          }
        }
        streams.push({
          name: relative(root, path).slice(0, -".db".length),
          bytes,
          reclaimable: await sqliteFreeBytes(path),
          modified,
        });
      }
    }
  };
  await visit(root, 0);
  return { streams, truncated };
}

// Marks as just changed the files in `root` that have edit history: `root`
// is a home the project can't reach yet (a snapshot's clone), about to
// replace the project's while it keeps its history (persist-volume.ts
// replaceProjectHome keepHistory).  A restored file is older than its
// history, so it would be taken as stale and the history written back over
// it (sync-fs initPath); marked new, it becomes the next version of its
// document.  Never follows a symlink.  The number of files marked.
export async function touchDocumentsWithHistory({
  project_id,
  root,
  // a little after now: strictly newer than the last edit of any document
  // (sync-fs initPath compares mtime > the history's newest patch time),
  // even with a patch in the same millisecond or a clock a little ahead
  now = new Date(Date.now() + TOUCH_MARGIN_MS),
  env = process.env,
}: {
  project_id: string;
  root: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const ctx = context(project_id, env);
  if (ctx == null || !(await isPersistVolumeReady(ctx.root))) return 0;
  const { streams } = await walk(ctx.root);
  const prefix = `/${PROJECT_HOME_IN_NAMES}`;
  const documents = new Set<string>();
  for (const { name } of streams) {
    const { document } = classify(name);
    if (document?.startsWith(prefix)) documents.add(document);
  }
  let touched = 0;
  for (const document of documents) {
    const parts = document.slice(prefix.length).split("/");
    let path = root;
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      path = join(path, parts[i]);
      const stat = await lstat(path).catch(() => undefined);
      ok = i < parts.length - 1 ? !!stat?.isDirectory() : !!stat?.isFile();
    }
    if (!ok) continue;
    try {
      await lutimes(path, now, now);
      touched += 1;
    } catch (err) {
      logger.warn("unable to mark a restored document changed", {
        project_id,
        document,
        err: `${err}`,
      });
    }
  }
  return touched;
}

export async function listPersistStorage({
  project_id,
  limit = 200,
  env = process.env,
}: {
  project_id: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<PersistStorageList> {
  const ctx = context(project_id, env);
  const empty = { count: 0, bytes: 0 };
  if (ctx == null) {
    return { supported: false, streams: [], total: empty, by_kind: {} };
  }
  if (!(await isPersistVolumeReady(ctx.root))) {
    // nothing imported yet: the history is still in the home
    return { supported: true, streams: [], total: empty, by_kind: {} };
  }
  const { streams, truncated } = await walk(ctx.root);
  const total: PersistStorageTotals = { count: 0, bytes: 0 };
  const by_kind: Partial<Record<PersistStreamKind, PersistStorageTotals>> = {};
  const infos: PersistStreamInfo[] = streams.map((stream) => {
    const { kind, document } = classify(stream.name);
    total.count += 1;
    total.bytes += stream.bytes;
    const k = (by_kind[kind] ??= { count: 0, bytes: 0 });
    k.count += 1;
    k.bytes += stream.bytes;
    return { ...stream, kind, ...(document ? { document } : {}) };
  });
  infos.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const listed = infos.slice(0, Math.max(0, Math.min(limit, 10_000)));
  for (const info of listed) {
    if (info.document) {
      const exists = await existsInHome(ctx.home, info.document);
      if (exists != null) info.document_exists = exists;
    }
  }
  // (more streams than listed: a cleanup planned from the list is partial)
  const partial = truncated || listed.length < infos.length;
  return {
    supported: true,
    streams: listed,
    total,
    by_kind,
    ...(partial ? { truncated: true } : {}),
  };
}

// The database of stream `name` in the volume, without its ".db"; refuses a
// name that is not exactly one of its streams.
async function streamPath(root: string, name: unknown): Promise<string> {
  if (
    typeof name != "string" ||
    name.length == 0 ||
    name.length > MAX_NAME_LENGTH ||
    name.startsWith("/") ||
    name.includes("\0") ||
    name.split("/").some((part) => part == "" || part == "." || part == "..")
  ) {
    throw new Error(`invalid stream name: ${name}`);
  }
  // no symlink anywhere on the way (the volume is host-only, but still)
  let path = root;
  const parts = `${name}.db`.split("/");
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]);
    const stat = await lstat(path).catch(() => undefined);
    const ok = i < parts.length - 1 ? stat?.isDirectory() : stat?.isFile();
    if (!ok) throw new Error(`no such stream: ${name}`);
  }
  return path.slice(0, -".db".length);
}

async function sizeOnDisk(path: string): Promise<number> {
  let bytes = 0;
  for (const suffix of SUFFIXES) bytes += await sizeOf(`${path}.db${suffix}`);
  return bytes;
}

// Copies of the stream the persist server keeps where configured: an archive
// (COCALC_SYNC_ARCHIVE; storage.ts copies it back over a missing or older
// database) and a backup written when it closes (COCALC_SYNC_BACKUP).  They go
// with it.
function streamCopy(
  kind: "COCALC_SYNC_ARCHIVE" | "COCALC_SYNC_BACKUP",
  project_id: string,
  name: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const dir = env[kind];
  if (!dir) return;
  return join(dir, "projects", project_id, name);
}

async function removeDatabase(path: string): Promise<void> {
  for (const suffix of SUFFIXES) {
    await unlink(`${path}.db${suffix}`).catch((err) => {
      if ((err as NodeJS.ErrnoException)?.code != "ENOENT") throw err;
    });
  }
}

// Removes the directories `path` leaves empty, up to (not including) root.
async function removeEmptyParents(root: string, path: string): Promise<void> {
  for (
    let dir = dirname(path);
    dir.startsWith(`${root}/`);
    dir = dirname(dir)
  ) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
  }
}

// Gives back the free pages of a closed database.
function compact(path: string): void {
  const db = new DatabaseSync(`${path}.db`);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

// The newest seq of an entry written before `before` (ms), if any.  (The
// storage keeps each entry's time in seconds.)
function lastSeqBefore(path: string, before: number): number | undefined {
  // (not read-only: that can't read a database in WAL mode without its -shm)
  const db = new DatabaseSync(`${path}.db`);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const row = db
      .prepare("SELECT MAX(seq) AS seq FROM messages WHERE time < ?")
      .get(before / 1000) as { seq: number | null } | undefined;
    return row?.seq == null ? undefined : Number(row.seq);
  } finally {
    db.close();
  }
}

// Keeps only what the action's policy keeps of the stream at `path` (closed
// and fenced); the number of entries removed.
async function trim(
  ctx: Context,
  path: string,
  action: Extract<PersistStorageAction, { op: "trim" }>,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const { policy } = action;
  const { kind } = classify(action.name);
  if (policy == null || RETENTION_POLICY_KINDS[policy.kind] == null) {
    throw new Error(`trim: unknown policy: ${(policy as any)?.kind}`);
  }
  if (!retentionPolicyApplies(policy, kind)) {
    throw new Error(
      `trim: "${policy.kind}" applies to ${RETENTION_POLICY_KINDS[policy.kind].join(" and ")} streams, not ${kind}`,
    );
  }
  if (policy.kind == "since" && !Number.isFinite(policy.since)) {
    throw new Error("trim: since must be a time in ms");
  }
  const cutoff =
    policy.kind == "since" ? lastSeqBefore(path, policy.since) : undefined;
  const archive = streamCopy(
    "COCALC_SYNC_ARCHIVE",
    ctx.project_id,
    action.name,
    env,
  );
  const backup = streamCopy(
    "COCALC_SYNC_BACKUP",
    ctx.project_id,
    action.name,
    env,
  );
  // (closing writes the trimmed stream to its copies)
  const stream = pstream({
    path,
    ...(archive ? { archive } : {}),
    ...(backup ? { backup } : {}),
    noCache: true,
  });
  let removed = 0;
  try {
    if (cutoff != null) {
      removed += stream.delete({ last_seq: cutoff }).seqs.length;
    }
    if (policy.kind == "without-archived") {
      for (let i = 0; i < MAX_ARCHIVE_PURGE_STEPS; i++) {
        const step = stream.purgeArchivedHistory();
        removed += step.records;
        if (step.done) break;
      }
    }
  } finally {
    stream.close();
  }
  return removed;
}

async function apply(
  ctx: Context,
  action: PersistStorageAction,
  env: NodeJS.ProcessEnv,
): Promise<PersistStorageActionResult> {
  const result: PersistStorageActionResult = {
    name: `${action?.name}`,
    op: action?.op,
    ok: false,
    freed: 0,
  };
  try {
    const path = await streamPath(ctx.root, action?.name);
    const before = await sizeOnDisk(path);
    if (action.op == "delete") {
      if (action.ifDocumentMissing) {
        // checked again now, with the project's streams fenced: listed as
        // gone, it may have been created again since
        const { document } = classify(action.name);
        const exists =
          document == null ? undefined : await existsInHome(ctx.home, document);
        if (exists !== false) {
          result.ok = true;
          result.skipped =
            exists === true
              ? "its document exists again"
              : "whether its document exists can't be told";
          return result;
        }
      }
      // the copies first: one left behind would bring the stream back
      // (storage.ts copies an archive over a missing database), and with the
      // database still here, deleting it again retries them
      for (const kind of [
        "COCALC_SYNC_ARCHIVE",
        "COCALC_SYNC_BACKUP",
      ] as const) {
        const copy = streamCopy(kind, ctx.project_id, action.name, env);
        if (copy) await removeDatabase(copy);
      }
      await removeDatabase(path);
      await removeEmptyParents(ctx.root, path);
    } else if (action.op == "trim") {
      result.removed = await trim(ctx, path, action, env);
      compact(path);
    } else {
      throw new Error(`unknown operation: ${(action as any)?.op}`);
    }
    result.freed = Math.max(0, before - (await sizeOnDisk(path)));
    result.ok = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : `${err}`;
  }
  return result;
}

// Deletes or trims streams of the project, while its streams are closed and
// fenced; each action succeeds or fails on its own.
export async function applyPersistStorage({
  project_id,
  actions,
  env = process.env,
}: {
  project_id: string;
  actions: PersistStorageAction[];
  env?: NodeJS.ProcessEnv;
}): Promise<PersistStorageApplyResult> {
  if (!Array.isArray(actions) || actions.length == 0) {
    return { results: [], freed: 0 };
  }
  if (actions.length > MAX_PERSIST_STORAGE_ACTIONS) {
    throw new Error(`at most ${MAX_PERSIST_STORAGE_ACTIONS} actions at once`);
  }
  const ctx = context(project_id, env);
  if (ctx == null || !(await isPersistVolumeReady(ctx.root))) {
    throw new Error(
      "this project's edit history is in its home, with its other files",
    );
  }
  const results = await withProjectStorageFenced(
    { project_id, reason: "manage-history", env },
    async () => {
      const results: PersistStorageActionResult[] = [];
      for (const action of actions) {
        results.push(await apply(ctx, action, env));
      }
      return results;
    },
  );
  const freed = results.reduce((sum, r) => sum + r.freed, 0);
  logger.info("managed project persist storage", {
    project_id,
    actions: results.length,
    failed: results.filter((r) => !r.ok).length,
    freed,
  });
  return { results, freed };
}
