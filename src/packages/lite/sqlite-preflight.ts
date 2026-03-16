import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { data } from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("lite:sqlite-preflight");

const DEFAULT_DB_FILES = ["hub.db", "sync-fs.sqlite"] as const;

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isReadonlySqliteError(err: unknown): boolean {
  const text =
    err instanceof Error
      ? `${err.message}\n${err.stack ?? ""}`
      : `${err ?? ""}`;
  return /readonly database/i.test(text);
}

function makeProbeTableName(): string {
  return `__cocalc_sqlite_write_probe_${process.pid}_${Date.now().toString(36)}`;
}

function assertFreshConnectionWritable(filename: string): void {
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE ${makeProbeTableName()}(x INTEGER)`);
      db.exec("ROLLBACK");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore cleanup errors while surfacing the original write failure
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

function repairReadonlySqliteFile(filename: string): boolean {
  const mode = statSync(filename).mode & 0o777;
  const rebuilt = `${filename}.repair-${process.pid}-${Date.now().toString(36)}`;
  const source = new DatabaseSync(filename);
  try {
    source.exec(`VACUUM INTO ${sqlStringLiteral(rebuilt)}`);
  } finally {
    source.close();
  }
  rmSync(`${filename}-wal`, { force: true });
  rmSync(`${filename}-shm`, { force: true });
  rmSync(filename, { force: true });
  renameSync(rebuilt, filename);
  // Lite sqlite files must remain writable by the owning account after
  // repair, even if the damaged source inode had lost that bit.
  chmodSync(filename, mode | 0o200);
  return true;
}

export function repairLiteSqliteFileIfNeeded(filename: string): boolean {
  if (!existsSync(filename)) return false;
  try {
    assertFreshConnectionWritable(filename);
    return false;
  } catch (err) {
    if (!isReadonlySqliteError(err)) {
      throw err;
    }
    logger.warn("repairing readonly lite sqlite file", { filename });
  }
  repairReadonlySqliteFile(filename);
  assertFreshConnectionWritable(filename);
  logger.info("repaired readonly lite sqlite file", { filename });
  return true;
}

// This must run before Lite opens its long-lived sqlite connections or spawns
// detached ACP workers. Replacing a live sqlite inode underneath another
// process is unsafe; startup preflight is the right repair point.
export function preflightRepairLiteSqliteFiles(
  files: readonly string[] = DEFAULT_DB_FILES.map((name) => join(data, name)),
): string[] {
  const repaired: string[] = [];
  for (const filename of files) {
    if (repairLiteSqliteFileIfNeeded(filename)) {
      repaired.push(filename);
    }
  }
  return repaired;
}
