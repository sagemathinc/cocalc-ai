/*
 * Before each command of an installed CLI (distribution Phase A): ask the
 * origin, at most every 10 minutes, which release it serves.
 *
 * - If the site requires a newer release than the active one, update now and
 *   re-run the command, or stop with a clear message when updates are off or
 *   held after a rollback.
 * - If a newer release is merely available, update in the background for the
 *   next run (or print a one-line notice when updates are off or held).
 *
 * A slow or unreachable site never blocks a command for long, and notices go
 * to stderr only when it's a terminal.
 *
 * In Phase A the site's min_release is advisory: it makes up-to-date CLIs
 * update before they talk to the site. Older CLIs ignore it, and a check that
 * times out lets the command run. Protocol compatibility itself is enforced
 * by the API, not by this check.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CliSiteInfo,
  parseSiteInfo,
} from "@cocalc/util/cli-distribution/schema";
import { activeRelease, cliRoot, readState, writeFileAtomic } from "./local";
import { fetchSiteInfo } from "./remote";
import { updateFromOrigin } from "./update";

const CHECK_INTERVAL_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 1_500;

interface Check {
  origin: string;
  at: number;
  site: CliSiteInfo | null;
  // The manifest a background update was last started for.
  started?: string;
}

async function writeCheck(root: string, check: Check): Promise<void> {
  await writeFileAtomic(
    join(root, "check.json"),
    JSON.stringify(check) + "\n",
  ).catch(() => {});
}

async function siteCheck(root: string, origin: string): Promise<Check> {
  try {
    const cached = JSON.parse(await readFile(join(root, "check.json"), "utf8"));
    if (
      cached.origin === origin &&
      Date.now() - cached.at < CHECK_INTERVAL_MS
    ) {
      return {
        origin,
        at: cached.at,
        site: cached.site ? parseSiteInfo(JSON.stringify(cached.site)) : null,
        started:
          typeof cached.started === "string" ? cached.started : undefined,
      };
    }
  } catch {
    // no usable cache
  }
  let site: CliSiteInfo | null = null;
  try {
    site = await fetchSiteInfo(origin, CHECK_TIMEOUT_MS);
  } catch {
    site = null;
  }
  const check = { origin, at: Date.now(), site };
  await writeCheck(root, check);
  return check;
}

function notice(message: string): void {
  if (process.stderr.isTTY) process.stderr.write(`${message}\n`);
}

export async function beforeCommand(
  argv: string[] = process.argv,
): Promise<void> {
  const command = argv[2];
  if (command === "update" || process.env.COCALC_CLI_ROOT == null) return;
  const root = cliRoot();
  const state = await readState(root).catch(() => undefined);
  if (state == null) return;
  const active = await activeRelease(root);
  if (active == null) return;
  const check = await siteCheck(root, state.origin);
  const site = check.site;
  if (site == null || site.manifest === active.manifest) return;
  const highest = state.origins[state.origin]?.highest_seen ?? 0;
  if (site.release < highest) return; // a lagging server; never downgrade

  const auto = state.auto && process.env.COCALC_AUTO_UPDATE !== "0";
  const held = state.held_at != null;
  const required =
    site.min_release != null && active.release < site.min_release;

  if (required) {
    if (!auto || held) {
      const how = held
        ? `You rolled back to release ${active.release}; run \`cocalc update --resume\`.`
        : "Run `cocalc update`.";
      process.stderr.write(
        `cocalc: ${state.origin} requires CoCalc CLI release ${site.min_release} or newer; this is release ${active.release}. ${how}\n`,
      );
      process.exit(1);
    }
    process.stderr.write(
      `Updating the CoCalc CLI to release ${site.release} (required by ${state.origin})...\n`,
    );
    try {
      await updateFromOrigin({ root, explicit: false });
    } catch (err) {
      process.stderr.write(
        `cocalc: the required update failed: ${err instanceof Error ? err.message : err}\nRun \`cocalc update\` to retry.\n`,
      );
      process.exit(1);
    }
    const rerun = spawnSync(state.launcher, argv.slice(2), {
      stdio: "inherit",
    });
    process.exit(rerun.status ?? 1);
  }

  if (held) {
    notice(
      `cocalc: held at release ${active.release}; release ${site.release} is available: cocalc update --resume`,
    );
    return;
  }
  if (!auto) {
    notice(
      `cocalc: CLI release ${site.release} is available from ${state.origin}: cocalc update`,
    );
    return;
  }
  if (check.started === site.manifest) return; // at most once per check
  await writeCheck(root, { ...check, started: site.manifest });
  const child = spawn(state.launcher, ["update", "--background"], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}
