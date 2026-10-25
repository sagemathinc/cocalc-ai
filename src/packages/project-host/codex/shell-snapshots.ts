/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { BeneathDir } from "../beneath-copy";
import { CODEX_EGRESS_PROXY_USERNAME } from "./restricted-egress-proxy";

const logger = getLogger("project-host:codex:shell-snapshots");

// No Codex credential mode may leave a credential in the project's files.
// Codex records the environment of its shell in CODEX_HOME/shell_snapshots,
// so a credential passed to Codex in its environment must be excluded from
// that shell. (The Codex process itself still reads it from its own env.)
// - OPENAI_API_KEY: API-key modes and the site-funded proxy token.
// - HTTPS_PROXY / https_proxy: with the project network disabled, the
//   restricted egress proxy URL, whose password is a session token. That
//   proxy only lets Codex reach OpenAI, so shell tools have no use for it.
const CODEX_CREDENTIAL_ENV_NAMES = [
  "OPENAI_API_KEY",
  "HTTPS_PROXY",
  "https_proxy",
] as const;
export const SHELL_ENVIRONMENT_EXCLUDE_CONFIG = `shell_environment_policy.exclude=[${CODEX_CREDENTIAL_ENV_NAMES.map((name) => JSON.stringify(name)).join(",")}]`;

// What marks an old snapshot as holding one of those credentials. The proxy
// variables are matched by the managed proxy's credential, not by name, so a
// project's own proxy setting does not count.
const SNAPSHOT_CREDENTIAL_MARKERS = [
  "OPENAI_API_KEY",
  `//${CODEX_EGRESS_PROXY_USERNAME}:`,
] as const;

// This runs in the shared project-host process before every app-server
// start, over a directory the project controls: bound the work. Listing stops
// after maxEntries names; a directory with more is not one Codex wrote in the
// normal way and is skipped (with one warning) rather than scanned. Reading
// stops after maxTotalBytes. There is one summary log line per start.
export const SHELL_SNAPSHOT_LIMITS = {
  maxEntries: 2_000,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
};

// Snapshots written before the exclusion above may hold such a credential
// (for example a site-funded proxy token). Remove those files. The directory
// is project-controlled: BeneathDir refuses symlinks at every step (with one
// root descriptor for the whole scan), and only regular files that hold such
// a credential are removed, so Codex's other state and current sessions'
// clean snapshots are left alone.
export async function purgeCredentialShellSnapshots(
  projectHome: string,
  limits = SHELL_SNAPSHOT_LIMITS,
): Promise<number> {
  const dir = new BeneathDir(projectHome, ".codex/shell_snapshots");
  let names: string[];
  let complete: boolean;
  try {
    ({ names, complete } = await dir.listUpTo(limits.maxEntries));
  } catch (err) {
    if ((err as any)?.code !== "ENOENT") {
      logger.debug("codex project: cannot list shell snapshots", {
        projectHome,
        err: `${err}`,
      });
    }
    return 0;
  }
  if (!complete) {
    logger.warn("codex project: too many shell snapshots to check", {
      projectHome,
      limit: limits.maxEntries,
    });
    return 0;
  }
  let removed = 0;
  let checked = 0;
  let bytes = 0;
  let errors = 0;
  let firstError: string | undefined;
  for (const name of names) {
    if (bytes >= limits.maxTotalBytes) break;
    try {
      if ((await dir.stat(name)).kind !== "file") continue;
      checked += 1;
      const data = dir.readFile(name, limits.maxFileBytes);
      if (data == null) continue;
      bytes += data.length;
      const text = data.toString("utf8");
      if (
        !SNAPSHOT_CREDENTIAL_MARKERS.some((marker) => text.includes(marker))
      ) {
        continue;
      }
      dir.unlink(name);
      removed += 1;
    } catch (err) {
      errors += 1;
      firstError ??= `${err}`;
    }
  }
  if (removed > 0 || errors > 0) {
    logger.info("codex project: checked shell snapshots for credentials", {
      projectHome,
      entries: names.length,
      checked,
      removed,
      errors,
      firstError,
    });
  }
  return removed;
}
