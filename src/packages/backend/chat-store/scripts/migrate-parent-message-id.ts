#!/usr/bin/env node

import path from "node:path";
import { migrateArchivedParentMessageIds } from "../migrate-parent-message-id";

interface CliOptions {
  dbPath: string;
  dryRun: boolean;
  noBackup: boolean;
}

function usage(): string {
  return [
    "Usage:",
    "  node dist/chat-store/scripts/migrate-parent-message-id.js <offload.sqlite3> [--dry-run] [--no-backup]",
    "",
    "Examples:",
    "  node dist/chat-store/scripts/migrate-parent-message-id.js ~/.local/share/cocalc/chats/offload-v1.sqlite3",
    "  node dist/chat-store/scripts/migrate-parent-message-id.js /tmp/offload.sqlite3 --dry-run",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  let dbPath: string | undefined;
  let dryRun = false;
  let noBackup = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--no-backup") {
      noBackup = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (!dbPath) {
      dbPath = arg;
      continue;
    }
    throw new Error(`Unexpected positional argument: ${arg}`);
  }
  if (!dbPath) {
    throw new Error("Missing <offload.sqlite3> path");
  }
  return {
    dbPath: path.resolve(dbPath),
    dryRun,
    noBackup,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = await migrateArchivedParentMessageIds({
    db_path: opts.dbPath,
    dry_run: opts.dryRun,
    no_backup: opts.noBackup,
  });
  console.log(
    JSON.stringify(
      {
        input: opts.dbPath,
        dry_run: opts.dryRun,
        no_backup: opts.noBackup,
        report,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(
    `migrate-parent-message-id failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
