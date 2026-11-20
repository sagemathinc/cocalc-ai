/*
 *  This file is part of CoCalc: Copyright (C) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const CATALOG_VERSION = 1;

type SourceFileSignature = {
  size: string;
  mtime_ns: string;
};

export type SqliteMirrorCatalogEntry = {
  kind: "sqlite" | "file";
  source_signature: string;
  snapshot_bytes: number;
  snapshot_sha256: string;
};

export type SqliteMirrorCatalog = {
  version: typeof CATALOG_VERSION;
  updated_at: string;
  entries: Record<string, SqliteMirrorCatalogEntry>;
};

export type RefreshSqliteMirrorResult = {
  scanned_files: number;
  current_files: number;
  changed_files: string[];
  deleted_files: string[];
  sqlite_backups: number;
  copied_files: number;
  catalog_path: string;
};

type BackupDatabase = (
  sourcePath: string,
  destinationPath: string,
) => Promise<void>;

function sqliteShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function defaultBackupDatabase(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  await execFile(
    "sqlite3",
    [
      sourcePath,
      ".timeout 5000",
      `.backup ${sqliteShellQuote(destinationPath)}`,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
}

async function fileSignature(
  path: string,
): Promise<SourceFileSignature | null> {
  try {
    const info = await stat(path, { bigint: true });
    if (!info.isFile()) return null;
    return {
      size: info.size.toString(),
      mtime_ns: info.mtimeNs.toString(),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function sourceSignature({
  sourcePath,
  sqlite,
}: {
  sourcePath: string;
  sqlite: boolean;
}): Promise<string> {
  const paths = sqlite
    ? [sourcePath, `${sourcePath}-wal`, `${sourcePath}-shm`]
    : [sourcePath];
  const signatures = await Promise.all(paths.map(fileSignature));
  return createHash("sha256").update(JSON.stringify(signatures)).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

// The persist's records marker (copy B) and its migration flag (028 ALT-D2,
// design note v8 rule 7) are never backed up: a restore must not bring back
// an old copy (the persist then refuses until a ruled recovery), and an
// import into a new bay must start without them.
export const PERSIST_RECORDS_STATE_EXCLUDES = new Set([
  ".cocalc-persist-state/records-marker.json",
  ".cocalc-persist-state/records-migrated.json",
]);

function excludedFromMirror(relativePath: string): boolean {
  return [...PERSIST_RECORDS_STATE_EXCLUDES].some(
    (name) => relativePath === name || relativePath.endsWith(`/${name}`),
  );
}

async function listSourceFiles(sourceDir: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (
        entry.isFile() &&
        !entry.name.endsWith(".db-wal") &&
        !entry.name.endsWith(".db-shm") &&
        !excludedFromMirror(relative(sourceDir, path))
      ) {
        files.push(relative(sourceDir, path));
      }
    }
  }
  await visit(sourceDir);
  return files;
}

async function readCatalog(path: string): Promise<SqliteMirrorCatalog> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: CATALOG_VERSION, updated_at: "", entries: {} };
    }
    throw err;
  }
  const catalog = value as Partial<SqliteMirrorCatalog>;
  if (
    catalog.version !== CATALOG_VERSION ||
    !catalog.entries ||
    typeof catalog.entries !== "object"
  ) {
    throw new Error(`unsupported or invalid SQLite mirror catalog: ${path}`);
  }
  return catalog as SqliteMirrorCatalog;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function runBounded<T>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (index < values.length) {
        const value = values[index++];
        await fn(value);
      }
    },
  );
  await Promise.all(workers);
}

export async function refreshSqliteMirror({
  sourceDir,
  mirrorDir,
  catalogPath = join(mirrorDir, ".cocalc-sqlite-mirror.json"),
  concurrency = 2,
  backupDatabase = defaultBackupDatabase,
  now = () => new Date(),
}: {
  sourceDir: string;
  mirrorDir: string;
  catalogPath?: string;
  concurrency?: number;
  backupDatabase?: BackupDatabase;
  now?: () => Date;
}): Promise<RefreshSqliteMirrorResult> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error(
      "SQLite mirror concurrency must be an integer from 1 through 16",
    );
  }
  await mkdir(mirrorDir, { recursive: true });
  const previous = await readCatalog(catalogPath);
  const sourceFiles = await listSourceFiles(sourceDir);
  const sourceSet = new Set(sourceFiles);
  const signatures = new Map<string, string>();
  await runBounded(sourceFiles, concurrency, async (relativePath) => {
    signatures.set(
      relativePath,
      await sourceSignature({
        sourcePath: join(sourceDir, relativePath),
        sqlite: relativePath.endsWith(".db"),
      }),
    );
  });
  const changedFiles = sourceFiles.filter(
    (relativePath) =>
      previous.entries[relativePath]?.source_signature !==
      signatures.get(relativePath),
  );
  const nextEntries: Record<string, SqliteMirrorCatalogEntry> = {
    ...previous.entries,
  };
  let sqliteBackups = 0;
  let copiedFiles = 0;
  await runBounded(changedFiles, concurrency, async (relativePath) => {
    const sourcePath = join(sourceDir, relativePath);
    const destinationPath = join(mirrorDir, relativePath);
    const temporaryPath = `${destinationPath}.tmp-${process.pid}-${randomUUID()}`;
    const sqlite = relativePath.endsWith(".db");
    await mkdir(dirname(destinationPath), { recursive: true });
    try {
      if (sqlite) {
        await backupDatabase(sourcePath, temporaryPath);
        sqliteBackups += 1;
      } else {
        await copyFile(sourcePath, temporaryPath);
        const sourceInfo = await stat(sourcePath);
        await chmod(temporaryPath, sourceInfo.mode);
        copiedFiles += 1;
      }
      const snapshotInfo = await stat(temporaryPath);
      const snapshotSha256 = await sha256File(temporaryPath);
      await rename(temporaryPath, destinationPath);
      nextEntries[relativePath] = {
        kind: sqlite ? "sqlite" : "file",
        source_signature: signatures.get(relativePath)!,
        snapshot_bytes: snapshotInfo.size,
        snapshot_sha256: snapshotSha256,
      };
    } finally {
      await rm(temporaryPath, { force: true });
    }
  });
  const deletedFiles = Object.keys(previous.entries)
    .filter((relativePath) => !sourceSet.has(relativePath))
    .sort();
  await runBounded(deletedFiles, concurrency, async (relativePath) => {
    await rm(join(mirrorDir, relativePath), { force: true });
    delete nextEntries[relativePath];
  });
  const catalog: SqliteMirrorCatalog = {
    version: CATALOG_VERSION,
    updated_at: now().toISOString(),
    entries: Object.fromEntries(
      Object.entries(nextEntries).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
  await writeJsonAtomic(catalogPath, catalog);
  return {
    scanned_files: sourceFiles.length,
    current_files: Object.keys(catalog.entries).length,
    changed_files: changedFiles,
    deleted_files: deletedFiles,
    sqlite_backups: sqliteBackups,
    copied_files: copiedFiles,
    catalog_path: catalogPath,
  };
}
