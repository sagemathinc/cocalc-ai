/*
 * `cocalc-plus update` and automatic updates for CoCalc Plus (Phase A).
 *
 * Releases come from software.cocalc.ai (PLUS_ORIGIN), the trusted origin.
 * Updates install in the background but never restart Lite: a running Lite
 * keeps running its own release (pinned), and the new one takes effect the
 * next time Lite starts.
 */

import { readFile } from "node:fs/promises";
import { parsePlusManifest } from "@cocalc/util/cli-distribution/plus-schema";
import type { CliCurrentPointer } from "@cocalc/util/cli-distribution/schema";
import {
  type CliState,
  DEFAULT_AUTO_UPDATE,
  STATE_SCHEMA,
  readState,
  sha256,
  validOrigin,
  withLock,
  writeState,
} from "./local";
import {
  type DataPaths,
  installPlusRelease,
  plusActiveRelease,
  plusRollback,
  readPlusManifest,
  restoreDataSnapshot,
} from "./plus";
import {
  fetchStoreManifestText,
  fetchStorePointer,
  storeFileFetcher,
} from "./remote";
import { confirmOnTty } from "./update";

export type Log = (message: string) => void;

export interface PlusUpdateOutcome {
  status: "updated" | "current" | "held" | "stale";
  message: string;
  release?: number;
  version?: string;
}

function notInstalled(): Error {
  return new Error(
    "This CoCalc Plus was not installed with software.cocalc.ai/software/plus/install.sh, so it can't update itself. Install it with: curl -fsSL https://software.cocalc.ai/software/plus/install.sh | sh",
  );
}

async function pointerManifest(
  origin: string,
  pointer: CliCurrentPointer,
): Promise<string> {
  const text = await fetchStoreManifestText(origin, pointer.manifest);
  const release = parsePlusManifest(text).release;
  if (release !== pointer.release) {
    throw new Error(
      `${origin} names release ${pointer.release}, but its manifest is release ${release}; refusing it.`,
    );
  }
  return text;
}

export async function updatePlusFromOrigin({
  root,
  explicit,
  log = () => {},
}: {
  root: string;
  explicit: boolean;
  log?: Log;
}): Promise<PlusUpdateOutcome> {
  const state = await readState(root);
  if (state == null) throw notInstalled();
  if (!explicit && state.held_at != null) {
    return {
      status: "held",
      message: `Held at release ${state.held_at} after a rollback; run \`cocalc-plus update --resume\` to update.`,
    };
  }
  const origin = state.origin;
  const pointer = await fetchStorePointer(origin);
  const highest = state.origins[origin]?.highest_seen ?? 0;
  if (pointer.release < highest) {
    return {
      status: "stale",
      message: `${origin} offers release ${pointer.release}, older than release ${highest} seen before; not downgrading.`,
    };
  }
  const active = await plusActiveRelease(root);
  if (active?.manifest === pointer.manifest) {
    if (explicit && state.held_at != null) {
      await withLock(root, async () => {
        const current = await readState(root);
        if (current) {
          current.held_at = null;
          await writeState(root, current);
        }
      });
    }
    return {
      status: "current",
      release: active.release,
      version: active.version,
      message: `CoCalc Plus is up to date (release ${active.release}, version ${active.version}).`,
    };
  }
  const manifestText = await pointerManifest(origin, pointer);
  const result = await installPlusRelease({
    root,
    origin,
    manifestText,
    manifestHash: pointer.manifest,
    fetchFile: storeFileFetcher(origin),
    prepareState: (current) => {
      if (current == null) throw notInstalled();
      if (current.origin !== origin) {
        throw new Error("the update source changed during the update; retry");
      }
      if (explicit) current.held_at = null;
      return current;
    },
    log,
  });
  return {
    status: "updated",
    release: result.release,
    version: result.version,
    message: `Installed CoCalc Plus release ${result.release} (version ${result.version}). It takes effect the next time CoCalc Plus starts.`,
  };
}

// Called by install.sh once it has staged and checked the first parts.
export async function finishPlusInstall({
  root,
  origin,
  manifestFile,
  launcherFile,
  launcherPath,
  log = () => {},
}: {
  root: string;
  origin: string;
  manifestFile: string;
  launcherFile: string;
  launcherPath: string;
  log?: Log;
}): Promise<PlusUpdateOutcome> {
  if (!validOrigin(origin)) throw new Error(`invalid origin: ${origin}`);
  if (!launcherPath.startsWith("/")) {
    throw new Error("the launcher path must be absolute");
  }
  const existing = await readState(root).catch(() => undefined);
  if (existing != null && existing.origin !== origin) {
    const question = `This replaces CoCalc Plus from ${existing.origin} with one from ${origin}, which will get full code execution as your user, now and on every update. Continue?`;
    if (process.env.COCALC_CLI_YES !== "1" && !confirmOnTty(question)) {
      throw new Error(
        `kept CoCalc Plus from ${existing.origin}; set COCALC_CLI_YES=1 to replace it without asking`,
      );
    }
  }
  const manifestText = await readFile(manifestFile, "utf8");
  const manifestHash = sha256(manifestText);
  const result = await installPlusRelease({
    root,
    origin,
    manifestText,
    manifestHash,
    launcherBytes: await readFile(launcherFile),
    fetchFile: storeFileFetcher(origin),
    prepareState: (current): CliState =>
      current == null
        ? {
            schema: STATE_SCHEMA,
            origin,
            mode: "origin-trust",
            auto: DEFAULT_AUTO_UPDATE,
            held_at: null,
            launcher: launcherPath,
            origins: {},
          }
        : { ...current, origin, launcher: launcherPath, held_at: null },
    log,
  });
  return {
    status: "updated",
    release: result.release,
    version: result.version,
    message: `Installed CoCalc Plus release ${result.release} (version ${result.version}) from ${origin}.`,
  };
}

// Roll back, and bring back the data that release last used when the
// snapshot has it.
export async function rollbackPlus({
  root,
  dataPaths,
  log = () => {},
}: {
  root: string;
  dataPaths: DataPaths;
  log?: Log;
}): Promise<void> {
  const to = await plusRollback(root, log);
  const restored = await restoreDataSnapshot(dataPaths, {
    manifest: to.manifest,
    release: to.release,
    version: to.version,
  });
  if (restored === "restored") {
    log(
      `Restored the data snapshot from release ${to.release}. The newer data is kept once in ${dataPaths.home}/data.replaced.`,
    );
  } else if (restored === "other-release") {
    log(
      "The data snapshot belongs to a different release, so the data was left as it is.",
    );
  } else {
    log("There is no data snapshot; the data was left as it is.");
  }
}

export async function describePlus(root: string): Promise<string[]> {
  const state = await readState(root);
  if (state == null) throw notInstalled();
  const active = await plusActiveRelease(root);
  const lines = [
    `Source:     ${state.origin} (trusted with full code execution as you)`,
    `Installed:  ${active ? `release ${active.release}, version ${active.version}` : "unknown"}`,
    `Automatic updates: ${
      process.env.COCALC_AUTO_UPDATE === "0"
        ? "off (COCALC_AUTO_UPDATE=0)"
        : state.auto
          ? "on (they take effect when CoCalc Plus next starts)"
          : "off"
    }${state.held_at != null ? `, held at release ${state.held_at} after a rollback` : ""}`,
  ];
  try {
    const pointer = await fetchStorePointer(state.origin);
    lines.push(`Available:  release ${pointer.release}`);
  } catch (err) {
    lines.push(
      `Available:  unknown (${err instanceof Error ? err.message : err})`,
    );
  }
  return lines;
}

export interface PlusUpdateStatus {
  running?: { release: number; version: string };
  installed?: { release: number; version: string };
  // A newer release is installed and takes effect on restart.
  restartToApply: boolean;
}

// For the "restart to apply" notice in Lite's UI.
export async function plusUpdateStatus(
  root: string,
  runningLine: string | undefined,
): Promise<PlusUpdateStatus> {
  const installed = await plusActiveRelease(root);
  const runningManifest = runningLine?.split(" ")[1];
  const running =
    runningManifest != null
      ? await readPlusManifest(root, runningManifest).catch(() => undefined)
      : undefined;
  return {
    running: running && { release: running.release, version: running.version },
    installed: installed && {
      release: installed.release,
      version: installed.version,
    },
    restartToApply:
      installed != null &&
      runningManifest != null &&
      installed.manifest !== runningManifest &&
      (running == null || installed.release > running.release),
  };
}

/*
 * Arguments after `cocalc-plus update`. Returns the exit code.
 */
export async function runPlusUpdateCommand(
  args: string[],
  { root, dataPaths }: { root: string; dataPaths: DataPaths },
): Promise<number> {
  // Output piped into e.g. `head` may close early; that is not an error.
  process.stdout.on("error", () => {});
  const say = (message: string) => process.stdout.write(`${message}\n`);
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (name: string) => args.includes(name);
  try {
    if (has("--finish-install")) {
      const origin = value("--origin");
      const manifestFile = value("--manifest-file");
      const launcherFile = value("--launcher-file");
      const launcherPath = value("--launcher-path");
      if (!origin || !manifestFile || !launcherFile || !launcherPath) {
        throw new Error(
          "--finish-install needs --origin, --manifest-file, --launcher-file and --launcher-path",
        );
      }
      say(
        (
          await finishPlusInstall({
            root,
            origin,
            manifestFile,
            launcherFile,
            launcherPath,
          })
        ).message,
      );
      return 0;
    }
    if (has("--background")) {
      await updatePlusFromOrigin({ root, explicit: false }).catch(() => {});
      return 0;
    }
    if (has("--check")) {
      for (const line of await describePlus(root)) say(line);
      return 0;
    }
    const auto = value("--auto");
    if (auto != null) {
      if (auto !== "on" && auto !== "off") {
        throw new Error("--auto takes on or off");
      }
      await withLock(root, async () => {
        const state = await readState(root);
        if (state == null) throw notInstalled();
        state.auto = auto === "on";
        await writeState(root, state);
      });
      say(`Automatic CoCalc Plus updates are ${auto}.`);
      return 0;
    }
    if (has("--rollback")) {
      await rollbackPlus({ root, dataPaths, log: say });
      return 0;
    }
    if (args.some((arg) => arg.startsWith("-") && arg !== "--resume")) {
      say(
        "Usage: cocalc-plus update [--check | --rollback | --resume | --auto on|off]",
      );
      return 1;
    }
    say(
      (await updatePlusFromOrigin({ root, explicit: true, log: say })).message,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `cocalc-plus update: ${err instanceof Error ? err.message : err}\n`,
    );
    return 1;
  }
}
