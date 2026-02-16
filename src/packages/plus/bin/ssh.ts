#!/usr/bin/env node
import { AsciiTable3 } from "ascii-table3";
import { Command } from "commander";
import {
  collectRepeatable,
  connectSession,
  canBindPort,
  getRemoteStatus,
  listSessions,
  parseDurationMs,
  pruneStaleSessions,
  statusSession,
} from "../ssh/core";

type ListOptions = {
  withStatus: boolean;
  ttlMs?: number;
  keep?: number;
  prune?: boolean;
};

async function listSessionsTable(opts: ListOptions) {
  if (opts.prune !== false) {
    pruneStaleSessions({ ttlMs: opts.ttlMs, keep: opts.keep });
  }
  const entries = listSessions({
    auto: false,
    ttlMs: opts.ttlMs,
    keep: opts.keep,
  });
  if (entries.length === 0) {
    console.log("No saved SSH targets.");
    return;
  }
  entries.sort((a, b) => {
    const av = a.lastUsed || "";
    const bv = b.lastUsed || "";
    return bv.localeCompare(av);
  });
  const header = opts.withStatus
    ? ["Target", "Port", "Status", "Tunnel", "Last Used"]
    : ["Target", "Port", "Last Used"];
  const rows: string[][] = [];
  for (const entry of entries) {
    const target = String(entry.target);
    const port = entry.localPort != null ? String(entry.localPort) : "";
    const lastUsed = entry.lastUsed || "";
    let status = "";
    let tunnel = "";
    if (opts.withStatus) {
      status = await getRemoteStatus(entry);
      if (entry.localPort != null) {
        tunnel = (await canBindPort(entry.localPort)) ? "idle" : "active";
      }
    }
    if (opts.withStatus) {
      rows.push([target, port, status, tunnel, lastUsed]);
    } else {
      rows.push([target, port, lastUsed]);
    }
  }
  const table = new AsciiTable3("SSH Targets")
    .setHeading(...header)
    .addRowMatrix(rows);
  table.setStyle("unicode-round");
  const targetWidth = Math.max(
    12,
    Math.ceil(Math.max(...rows.map((row) => row[0].length)) / 2),
  );
  table.setWidth(1, targetWidth).setWrapped(1);
  console.log(table.toString());
}

function parseOptionalKeep(value?: string): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid --keep '${value}' (must be a non-negative integer)`);
  }
  return Math.floor(n);
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const program = new Command();
  program
    .name("cocalc-plus ssh")
    .usage("user@host[:port] [options]")
    .showHelpAfterError()
    .argument("[target]")
    .option("--target <target>", "disambiguate targets named list/status/stop")
    .option("--local-port <n|auto>")
    .option("--remote-port <n|auto>")
    .option("--no-open")
    .option("--no-install")
    .option("--upgrade")
    .option("--forward-only")
    .option("--ssh-arg <arg>", "(repeatable)", collectRepeatable, [])
    .option("--identity <file>")
    .option("--proxy-jump <host>")
    .option("--log-level <info|debug>", "", "info")
    .addHelpText(
      "after",
      `\nExamples:\n  cocalc-plus ssh user@host\n  cocalc-plus ssh list\n  cocalc-plus ssh status user@host\n  cocalc-plus ssh stop user@host\n  cocalc-plus ssh --target list\n  cocalc-plus ssh -- list\n  cocalc-plus ssh user@host:2222 --identity ~/.ssh/id_ed25519\n  cocalc-plus ssh user@host --proxy-jump jumpbox\n  cocalc-plus ssh user@host --no-open --local-port 42800\n`,
    )
    .action(async (target: string | undefined, options) => {
      const finalTarget = options.target ?? target;
      if (!finalTarget) {
        program.help({ error: true });
        return;
      }
      const result = await connectSession(finalTarget, options);
      result.tunnel.on("exit", (code) => process.exit(code ?? 0));
    });

  program
    .command("list")
    .description("list saved ssh targets")
    .option("--ttl <duration>", "stale TTL, e.g. 30d, 12h, 45m")
    .option("--keep <count>", "always keep this many most-recent entries")
    .option("--no-prune", "disable stale-entry pruning for this command")
    .action(async (options) => {
      const ttlMs =
        options.ttl != null ? parseDurationMs(String(options.ttl)) : undefined;
      const keep = parseOptionalKeep(options.keep);
      await listSessionsTable({
        withStatus: true,
        ttlMs,
        keep,
        prune: options.prune,
      });
    });

  program
    .command("status")
    .argument("[target]")
    .option("--target <target>")
    .option("--ssh-arg <arg>", "(repeatable)", collectRepeatable, [])
    .option("--identity <file>")
    .option("--proxy-jump <host>")
    .action(async (target: string | undefined, options) => {
      const finalTarget = options.target ?? target;
      if (!finalTarget) {
        program.error("Missing target for status.");
        return;
      }
      await statusSession("status", finalTarget, options);
    });

  program
    .command("stop")
    .argument("[target]")
    .option("--target <target>")
    .option("--ssh-arg <arg>", "(repeatable)", collectRepeatable, [])
    .option("--identity <file>")
    .option("--proxy-jump <host>")
    .action(async (target: string | undefined, options) => {
      const finalTarget = options.target ?? target;
      if (!finalTarget) {
        program.error("Missing target for stop.");
        return;
      }
      await statusSession("stop", finalTarget, options);
    });

  await program.parseAsync(argv, { from: "user" });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("cocalc-plus ssh failed:", err?.message || err);
    process.exit(1);
  });
}
