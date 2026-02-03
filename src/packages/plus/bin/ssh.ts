#!/usr/bin/env node
import { AsciiTable3 } from "ascii-table3";
import { Command } from "commander";
import {
  collectRepeatable,
  connectSession,
  getRemoteStatus,
  listSessions,
  statusSession,
} from "../ssh/core";

async function listSessionsTable(withStatus: boolean) {
  const entries = listSessions();
  if (entries.length === 0) {
    console.log("No saved SSH targets.");
    return;
  }
  entries.sort((a, b) => {
    const av = a.lastUsed || "";
    const bv = b.lastUsed || "";
    return bv.localeCompare(av);
  });
  const header = withStatus
    ? ["Target", "Port", "Status", "Last Used"]
    : ["Target", "Port", "Last Used"];
  const rows: string[][] = [];
  for (const entry of entries) {
    const target = String(entry.target);
    const port = entry.localPort != null ? String(entry.localPort) : "";
    const lastUsed = entry.lastUsed || "";
    let status = "";
    if (withStatus) {
      status = await getRemoteStatus(entry);
    }
    if (withStatus) {
      rows.push([target, port, status, lastUsed]);
    } else {
      rows.push([target, port, lastUsed]);
    }
  }
  const table = new AsciiTable3("SSH Targets")
    .setHeading(...header)
    .addRowMatrix(rows);
  table.setStyle("unicode-round");
  table.setWidth(1, 15).setWrapped(1);
  console.log(table.toString());
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
    .action(async () => {
      await listSessionsTable(true);
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
