#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { migrateChatRows, parseJsonLines, toJsonLines } from "../migrate-v1-to-v2";

interface CliOptions {
  inputPath: string;
  outputPath: string;
  dryRun: boolean;
  noBackup: boolean;
  keepLegacyThreadFields: boolean;
}

function usage(): string {
  return [
    "Usage:",
    "  node dist/scripts/migrate-v1-to-v2.js <chat-file> [--out <path>] [--dry-run] [--no-backup] [--strip-root-thread-fields]",
    "",
    "Examples:",
    "  node dist/scripts/migrate-v1-to-v2.js /home/wstein/build/cocalc-lite3/lite3.chat",
    "  node dist/scripts/migrate-v1-to-v2.js /tmp/a.chat --dry-run",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let dryRun = false;
  let noBackup = false;
  let keepLegacyThreadFields = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--no-backup") {
      noBackup = true;
      continue;
    }
    if (arg === "--strip-root-thread-fields") {
      keepLegacyThreadFields = false;
      continue;
    }
    if (arg === "--out") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--out requires a path");
      }
      outputPath = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (!inputPath) {
      inputPath = arg;
      continue;
    }
    throw new Error(`Unexpected positional argument: ${arg}`);
  }

  if (!inputPath) {
    throw new Error("Missing <chat-file> path");
  }
  return {
    inputPath: path.resolve(inputPath),
    outputPath: path.resolve(outputPath ?? inputPath),
    dryRun,
    noBackup,
    keepLegacyThreadFields,
  };
}

async function createBackup(inputPath: string): Promise<string> {
  const base = `${inputPath}.bak`;
  try {
    await fs.access(base);
    const stamped = `${base}.${Date.now()}`;
    await fs.copyFile(inputPath, stamped);
    return stamped;
  } catch {
    await fs.copyFile(inputPath, base);
    return base;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(opts.inputPath, "utf8");
  const parsed = parseJsonLines(raw);
  const { rows, report } = migrateChatRows(parsed, {
    keepLegacyThreadFields: opts.keepLegacyThreadFields,
  });
  const output = toJsonLines(rows);

  let backupPath: string | undefined;
  if (!opts.dryRun) {
    if (opts.outputPath === opts.inputPath && !opts.noBackup) {
      backupPath = await createBackup(opts.inputPath);
    }
    await fs.writeFile(opts.outputPath, output, "utf8");
  }

  const summary = {
    input: opts.inputPath,
    output: opts.outputPath,
    dry_run: opts.dryRun,
    backup: backupPath ?? null,
    keep_legacy_thread_fields: opts.keepLegacyThreadFields,
    report,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(`migrate-v1-to-v2 failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
