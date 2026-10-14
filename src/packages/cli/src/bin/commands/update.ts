/*
 * cocalc update: update this CLI from the CoCalc site it was installed from
 * (distribution Phase A, src/.agents/cli-distribution-2026-10-12.md).
 */

import { Command, Option } from "commander";
import { cliRoot } from "../../distribution/local";
import {
  describeInstall,
  finishInstall,
  rollback,
  setAutoUpdate,
  switchOrigin,
  updateFromOrigin,
} from "../../distribution/update";

interface UpdateOptions {
  check?: boolean;
  rollback?: boolean;
  resume?: boolean;
  auto?: string;
  from?: string;
  yes?: boolean;
  background?: boolean;
  finishInstall?: boolean;
  origin?: string;
  manifestFile?: string;
  launcherFile?: string;
  launcherPath?: string;
}

const say = (message: string) => process.stdout.write(`${message}\n`);

export async function runUpdateCommand(opts: UpdateOptions): Promise<void> {
  const root = cliRoot();
  if (opts.finishInstall) {
    if (!opts.origin || !opts.manifestFile || !opts.launcherFile) {
      throw new Error(
        "--finish-install needs --origin, --manifest-file and --launcher-file",
      );
    }
    const outcome = await finishInstall({
      root,
      origin: opts.origin,
      manifestFile: opts.manifestFile,
      launcherFile: opts.launcherFile,
      launcherPath: opts.launcherPath ?? "",
    });
    say(outcome.message);
    return;
  }
  if (opts.background) {
    // Started by the CLI itself; never prints and never asks.
    await updateFromOrigin({ root, explicit: false }).catch(() => {});
    return;
  }
  if (opts.check) {
    for (const line of await describeInstall(root)) say(line);
    return;
  }
  if (opts.auto != null) {
    if (opts.auto !== "on" && opts.auto !== "off") {
      throw new Error("--auto takes on or off");
    }
    await setAutoUpdate(root, opts.auto === "on");
    say(`Automatic CLI updates are ${opts.auto}.`);
    return;
  }
  if (opts.rollback) {
    await rollback(root, say);
    return;
  }
  if (opts.from != null) {
    say(
      (
        await switchOrigin({
          root,
          input: opts.from,
          yes: !!opts.yes,
          log: say,
        })
      ).message,
    );
    return;
  }
  // A plain `cocalc update` (or --resume) is explicit: it clears a hold.
  const outcome = await updateFromOrigin({ root, explicit: true, log: say });
  say(outcome.message);
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("update this CLI from the CoCalc site it was installed from")
    .option(
      "--check",
      "show the installed and available releases, change nothing",
    )
    .option(
      "--rollback",
      "go back to the previous release and hold automatic updates",
    )
    .option("--resume", "clear a rollback hold and update")
    .option("--auto <on|off>", "turn automatic updates on or off")
    .option(
      "--from <site>",
      "update from another CoCalc site from now on (asks first)",
    )
    .option("--yes", "do not ask for confirmation")
    .addOption(new Option("--background").hideHelp())
    .addOption(new Option("--finish-install").hideHelp())
    .addOption(new Option("--origin <url>").hideHelp())
    .addOption(new Option("--manifest-file <path>").hideHelp())
    .addOption(new Option("--launcher-file <path>").hideHelp())
    .addOption(new Option("--launcher-path <path>").hideHelp())
    .action(async (opts: UpdateOptions) => {
      try {
        await runUpdateCommand(opts);
      } catch (err) {
        process.stderr.write(
          `cocalc update: ${err instanceof Error ? err.message : err}\n`,
        );
        process.exitCode = 1;
      }
    });
}
