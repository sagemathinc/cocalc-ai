/*
 * `cocalc update` and the install hand-off (distribution Phase A).
 *
 * The CLI updates only from the origin it was installed from; it trusts that
 * origin with full code execution as this user. Updates only move forward:
 * a site answering with a lower release number than this machine has seen
 * from it is ignored, so a lagging server never downgrades anyone.
 */

import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  type CliSiteInfo,
  parseManifest,
} from "@cocalc/util/cli-distribution/schema";
import {
  type CliState,
  DEFAULT_AUTO_UPDATE,
  STATE_SCHEMA,
  activeRelease,
  installRelease,
  normalizeOrigin,
  readState,
  rollback,
  sha256,
  validOrigin,
  withLock,
  writeState,
} from "./local";
import { fetchManifestText, fetchSiteInfo, originFileFetcher } from "./remote";

export type Log = (message: string) => void;

export function notInstalledError(): Error {
  return new Error(
    "This CLI was not installed with <site>/cli/install.sh, so it can't update itself. Install it with: curl -fsSL https://<your CoCalc site>/cli/install.sh | sh",
  );
}

// Ask on the terminal even when stdin is a pipe (as in `curl ... | sh`).
export function confirmOnTty(question: string): boolean {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return false;
  }
  try {
    writeSync(fd, `${question} [y/N] `);
    const buffer = Buffer.alloc(1);
    let answer = "";
    while (answer.length < 64 && readSync(fd, buffer, 0, 1, null) === 1) {
      const char = buffer.toString("utf8");
      if (char === "\n") break;
      answer += char;
    }
    return /^\s*y(es)?\s*$/i.test(answer);
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

// The site's release number must be the manifest's own.
async function siteManifest(
  origin: string,
  site: CliSiteInfo,
): Promise<string> {
  const text = await fetchManifestText(origin, site.manifest);
  const release = parseManifest(text).release;
  if (release !== site.release) {
    throw new Error(
      `${origin} names release ${site.release}, but its manifest is release ${release}; refusing it.`,
    );
  }
  return text;
}

export interface UpdateOutcome {
  status: "updated" | "current" | "held" | "stale";
  message: string;
  release?: number;
  site?: CliSiteInfo;
}

async function clearHold(root: string): Promise<void> {
  await withLock(root, async () => {
    const state = await readState(root);
    if (state != null && state.held_at != null) {
      state.held_at = null;
      await writeState(root, state);
    }
  });
}

/*
 * Update to the site's current release. `explicit` is a person running
 * `cocalc update` (or --resume): it clears a rollback hold. Automatic
 * updates never move a held installation.
 */
export async function updateFromOrigin({
  root,
  explicit,
  log = () => {},
}: {
  root: string;
  explicit: boolean;
  log?: Log;
}): Promise<UpdateOutcome> {
  const state = await readState(root);
  if (state == null) throw notInstalledError();
  if (!explicit && state.held_at != null) {
    return {
      status: "held",
      message: `Held at release ${state.held_at} after a rollback; run \`cocalc update --resume\` to update.`,
    };
  }
  const origin = state.origin;
  const site = await fetchSiteInfo(origin);
  const highest = state.origins[origin]?.highest_seen ?? 0;
  if (site.release < highest) {
    return {
      status: "stale",
      site,
      message: `${origin} offers release ${site.release}, older than release ${highest} seen before; not downgrading.`,
    };
  }
  const active = await activeRelease(root);
  if (active?.manifest === site.manifest) {
    if (explicit) await clearHold(root);
    return {
      status: "current",
      site,
      release: active.release,
      message: `The CoCalc CLI is up to date (release ${active.release}, version ${active.version}, from ${origin}).`,
    };
  }
  const manifestText = await siteManifest(origin, site);
  const result = await installRelease({
    root,
    origin,
    manifestText,
    manifestHash: site.manifest,
    fetchFile: originFileFetcher(origin, site.manifest),
    prepareState: (current) => {
      if (current == null) throw notInstalledError();
      if (current.origin !== origin) {
        throw new Error("the CLI's origin changed during the update; retry");
      }
      if (explicit) current.held_at = null;
      return current;
    },
    log,
  });
  return {
    status: "updated",
    site,
    release: result.release,
    message: `Updated the CoCalc CLI to release ${result.release} (version ${result.version}) from ${origin}.`,
  };
}

export async function switchOrigin({
  root,
  input,
  yes,
  log = () => {},
}: {
  root: string;
  input: string;
  yes: boolean;
  log?: Log;
}): Promise<UpdateOutcome> {
  const state = await readState(root);
  if (state == null) throw notInstalledError();
  const origin = normalizeOrigin(input);
  if (origin === state.origin) {
    return await updateFromOrigin({ root, explicit: true, log });
  }
  const question = `Switch CLI updates from ${state.origin} to ${origin}? ${origin} will get full code execution as your user, now and on every update.`;
  if (!yes && !confirmOnTty(question)) {
    throw new Error(`kept ${state.origin}; nothing changed`);
  }
  const site = await fetchSiteInfo(origin);
  const manifestText = await siteManifest(origin, site);
  const result = await installRelease({
    root,
    origin,
    manifestText,
    manifestHash: site.manifest,
    fetchFile: originFileFetcher(origin, site.manifest),
    prepareState: (current) => {
      if (current == null) throw notInstalledError();
      return { ...current, origin, held_at: null };
    },
    log,
  });
  return {
    status: "updated",
    site,
    release: result.release,
    message: `The CLI now updates from ${origin}: release ${result.release} (version ${result.version}) is active.`,
  };
}

// Called by <site>/cli/install.sh once it has staged and checked the files.
export async function finishInstall({
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
}): Promise<UpdateOutcome> {
  if (!validOrigin(origin)) throw new Error(`invalid origin: ${origin}`);
  if (!launcherPath.startsWith("/")) {
    throw new Error("the launcher path must be absolute");
  }
  const existing = await readState(root).catch(() => undefined);
  if (existing != null && existing.origin !== origin) {
    const question = `This replaces the CLI installed from ${existing.origin} with one from ${origin}, which will get full code execution as your user, now and on every update. Continue?`;
    if (process.env.COCALC_CLI_YES !== "1" && !confirmOnTty(question)) {
      throw new Error(
        `kept the CLI from ${existing.origin}; set COCALC_CLI_YES=1 to replace it without asking`,
      );
    }
  }
  const manifestText = await readFile(manifestFile, "utf8");
  const manifestHash = sha256(manifestText);
  const launcherBytes = await readFile(launcherFile);
  const result = await installRelease({
    root,
    origin,
    manifestText,
    manifestHash,
    launcherBytes,
    fetchFile: originFileFetcher(origin, manifestHash),
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
    message: `Installed CoCalc CLI release ${result.release} (version ${result.version}) from ${origin}.`,
  };
}

export async function setAutoUpdate(root: string, on: boolean): Promise<void> {
  await withLock(root, async () => {
    const state = await readState(root);
    if (state == null) throw notInstalledError();
    state.auto = on;
    await writeState(root, state);
  });
}

export async function describeInstall(root: string): Promise<string[]> {
  const state = await readState(root);
  if (state == null) throw notInstalledError();
  const active = await activeRelease(root);
  const lines = [
    `Origin:     ${state.origin} (trusted with full code execution as you)`,
    `Installed:  ${active ? `release ${active.release}, version ${active.version}` : "unknown"}`,
    `Automatic updates: ${
      process.env.COCALC_AUTO_UPDATE === "0"
        ? "off (COCALC_AUTO_UPDATE=0)"
        : state.auto
          ? "on"
          : "off"
    }${state.held_at != null ? `, held at release ${state.held_at} after a rollback` : ""}`,
  ];
  try {
    const site = await fetchSiteInfo(state.origin);
    lines.push(
      `Available:  release ${site.release}${site.min_release ? ` (the site requires at least ${site.min_release})` : ""}`,
    );
  } catch (err) {
    lines.push(
      `Available:  unknown (${err instanceof Error ? err.message : err})`,
    );
  }
  return lines;
}

export { rollback };
