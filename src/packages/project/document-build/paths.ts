/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_PROJECT_RUNTIME_HOME,
  PROJECT_RUNTIME_HOME_ALIASES,
  projectRuntimePathForProcess,
} from "@cocalc/util/project-runtime";

type Env = Readonly<Record<string, string | undefined>>;

// The project's home as clients address it, as get_homeDirectory reports it:
// a workspace runtime's canonical home (COCALC_RUNTIME_HOME), else the
// process's own HOME (in cocalc-plus and lite that is the user's real home,
// such as /Users/alice); /home/user only if neither is set.
function documentHome(env: Env): string {
  const runtimeHome = `${env.COCALC_RUNTIME_HOME ?? ""}`.trim();
  if (runtimeHome) return path.posix.resolve(runtimeHome);
  const home = `${env.HOME ?? ""}`.trim();
  if (home && path.posix.isAbsolute(home)) return path.posix.resolve(home);
  return DEFAULT_PROJECT_RUNTIME_HOME;
}

// Absolute paths that name the same home: the home itself, its real path
// when HOME is a symlink (get_homeDirectory reports the real path), and in a
// project container the legacy /root home.
function documentHomeAliases(home: string): string[] {
  const aliases = new Set([home]);
  try {
    aliases.add(path.posix.resolve(realpathSync(home)));
  } catch {
    // A home that doesn't exist here (a workspace runtime's canonical home)
    // has no other name.
  }
  if (home === DEFAULT_PROJECT_RUNTIME_HOME) {
    for (const alias of PROJECT_RUNTIME_HOME_ALIASES) aliases.add(alias);
  }
  return [...aliases];
}

function within(candidate: string, home: string): boolean {
  return candidate === home || candidate.startsWith(`${home}/`);
}

export function normalizeDocumentPath(
  rawPath: string,
  env: Env = process.env,
): string {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("document build path must be nonempty");
  }
  const runtimeHome = documentHome(env);
  const input = rawPath.trim().replace(/\\/g, "/");
  let relative: string;
  if (path.posix.isAbsolute(input)) {
    const normalized = path.posix.resolve(input);
    const home = documentHomeAliases(runtimeHome).find((candidate) =>
      within(normalized, candidate),
    );
    if (home == null) {
      throw new Error(`document build path must be inside ${runtimeHome}`);
    }
    relative = path.posix.relative(home, normalized);
  } else {
    relative = path.posix.normalize(input);
    if (
      relative === ".." ||
      relative.startsWith("../") ||
      path.posix.isAbsolute(relative)
    ) {
      throw new Error(`document build path must be inside ${runtimeHome}`);
    }
  }
  if (!relative || relative === ".") {
    throw new Error("document build path must identify a file");
  }
  return path.posix.join(runtimeHome, relative);
}

export function documentProcessPath(
  projectPath: string,
  env: Env = process.env,
): string {
  const normalized = normalizeDocumentPath(projectPath, env);
  const processPath = projectRuntimePathForProcess(normalized, env);
  if (processPath == null) throw new Error("unable to resolve document path");
  const home = path.resolve(env.HOME || DEFAULT_PROJECT_RUNTIME_HOME);
  const resolved = path.resolve(processPath);
  const relative = path.relative(home, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`document build path must be inside ${home}`);
  }
  return resolved;
}
