/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Files that let an agent use gh, git and cf with a CLI connector token.
//
// Wrappers are written once per runtime lease and put first on PATH. Token
// files exist only while a turn of an agent with that connector turned on is
// running; without one, every wrapper just runs the real command unchanged.

import { join } from "node:path";
import { BeneathDir } from "../beneath-copy";
import {
  CLI_CONNECTORS,
  CLI_CONNECTOR_INFO,
  type CliConnector,
  type CliConnectorTurnToken,
} from "@cocalc/util/ai/cli-connectors";

export const CLI_CONNECTOR_DIR = "cli";

function tokenFile(connector: CliConnector): string {
  return `${connector}-token`;
}

// The real command is the first one on PATH that is not this wrapper.
function wrapperScript({
  command,
  envVar,
  connector,
  missing,
}: {
  command: string;
  envVar: string;
  connector: CliConnector;
  missing: string;
}): string {
  return `#!/bin/sh
# CoCalc ${CLI_CONNECTOR_INFO[connector].label} connector wrapper for ${command}.
self_dir=$(cd "$(dirname "$0")" && pwd)
real=""
old_ifs=$IFS
IFS=:
for d in $PATH; do
  [ "$d" = "$self_dir" ] && continue
  if [ -x "$d/${command}" ]; then real="$d/${command}"; break; fi
done
IFS=$old_ifs
if [ -z "$real" ]; then
  echo "${command}: not installed in this project. ${missing}" >&2
  exit 127
fi
token_file="$self_dir/../${tokenFile(connector)}"
if [ -r "$token_file" ]; then
  ${envVar}=$(cat "$token_file")
  export ${envVar}
fi
exec "$real" "$@"
`;
}

const GIT_CREDENTIAL_HELPER = `#!/bin/sh
# CoCalc GitHub connector: git credentials for https://github.com only.
[ "$1" = get ] || exit 0
token_file="$(cd "$(dirname "$0")" && pwd)/../${tokenFile("github")}"
protocol=""
host=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    protocol=*) protocol=\${line#protocol=} ;;
    host=*) host=\${line#host=} ;;
  esac
done
[ "$protocol" = https ] && [ "$host" = github.com ] || exit 0
[ -r "$token_file" ] || exit 0
printf 'username=x-access-token\\npassword=%s\\n' "$(cat "$token_file")"
`;

const WRAPPERS: {
  name: string;
  connector: CliConnector;
  envVar: string;
  missing: string;
}[] = [
  {
    name: "gh",
    connector: "github",
    envVar: "GH_TOKEN",
    missing: "Install GitHub's gh CLI.",
  },
  {
    name: "cf",
    connector: "cloudflare",
    envVar: "CLOUDFLARE_API_TOKEN",
    missing:
      "Install it with: npm install -g --prefix ~/.local cf (the project needs internet access)",
  },
  {
    name: "wrangler",
    connector: "cloudflare",
    envVar: "CLOUDFLARE_API_TOKEN",
    missing:
      "Install it with: npm install -g --prefix ~/.local wrangler (the project needs internet access)",
  },
];

export const GIT_CREDENTIAL_HELPER_NAME = "git-credential-cocalc";

// git with the GitHub connector: only while a token is present, github.com
// credentials come from CoCalc alone. The empty helper resets every helper
// configured before it, so no other helper (e.g. "store") is asked to save
// the connector token. Without a token this runs git unchanged.
const GIT_WRAPPER = `#!/bin/sh
# CoCalc GitHub connector wrapper for git.
self_dir=$(cd "$(dirname "$0")" && pwd)
real=""
old_ifs=$IFS
IFS=:
for d in $PATH; do
  [ "$d" = "$self_dir" ] && continue
  if [ -x "$d/git" ]; then real="$d/git"; break; fi
done
IFS=$old_ifs
if [ -z "$real" ]; then
  echo "git: not installed in this project." >&2
  exit 127
fi
if [ -r "$self_dir/../${tokenFile("github")}" ]; then
  exec "$real" -c credential.https://github.com.helper= \\
    -c "credential.https://github.com.helper=$self_dir/${GIT_CREDENTIAL_HELPER_NAME}" "$@"
fi
exec "$real" "$@"
`;

/**
 * Writes the wrappers of the given (site-enabled) connectors only, in the
 * lease directory `leaseDir` (in the project's scratch or home, so never
 * through a symlink: see BeneathDir).
 */
export async function writeCliConnectorTools(
  leaseDir: BeneathDir,
  connectors: readonly CliConnector[] = CLI_CONNECTORS,
): Promise<void> {
  const dir = leaseDir.child(CLI_CONNECTOR_DIR);
  const bin = dir.child("bin");
  dir.mkdir(0o700);
  bin.mkdir(0o700);
  for (const { name, connector, envVar, missing } of WRAPPERS) {
    if (!connectors.includes(connector)) continue;
    bin.writeFile(
      name,
      wrapperScript({ command: name, envVar, connector, missing }),
      0o700,
    );
  }
  if (!connectors.includes("github")) return;
  bin.writeFile(GIT_CREDENTIAL_HELPER_NAME, GIT_CREDENTIAL_HELPER, 0o700);
  bin.writeFile("git", GIT_WRAPPER, 0o700);
}

let siteConnectorsCache: { at: number; connectors: CliConnector[] } | undefined;

/**
 * The connectors the site has set up, cached briefly. With none (the default
 * on a new site), agents get no wrappers, no PATH change and no per-turn
 * connector request. Errors count as none: dormant is the safe default.
 */
export async function siteCliConnectors(
  getCustomize: ((fields: string[]) => Promise<any>) | undefined,
  now = Date.now(),
): Promise<CliConnector[]> {
  if (siteConnectorsCache && now - siteConnectorsCache.at < 60_000) {
    return siteConnectorsCache.connectors;
  }
  let connectors: CliConnector[] = [];
  try {
    const customize = await getCustomize?.(["cliConnectors"]);
    const listed = customize?.cliConnectors;
    connectors = Array.isArray(listed)
      ? CLI_CONNECTORS.filter((connector) => listed.includes(connector))
      : [];
  } catch {
    // Not cached: the next lease asks again.
    return [];
  }
  siteConnectorsCache = { at: now, connectors };
  return connectors;
}

/** For tests. */
export function resetSiteCliConnectorsCache(): void {
  siteConnectorsCache = undefined;
}

// Puts the wrappers (gh, git, cf, wrangler) first on PATH.
export function applyCliConnectorEnv(
  env: Record<string, string | undefined>,
  containerDir: string,
): void {
  const bin = join(containerDir, CLI_CONNECTOR_DIR, "bin");
  const path = `${env.PATH ?? ""}`
    .split(":")
    .filter((part) => part && part !== bin);
  env.PATH = [bin, ...path].join(":");
}

function validToken(token: string): boolean {
  return !!token && token.length <= 4096 && !/\s/.test(token);
}

// Makes the token files match exactly the given tokens. Fails closed: if
// any write fails, every token file is removed and the error is rethrown.
export async function syncCliConnectorTokens(
  leaseDir: BeneathDir,
  tokens: CliConnectorTurnToken[],
): Promise<void> {
  try {
    await writeCliConnectorTokens(leaseDir, tokens);
  } catch (err) {
    await clearCliConnectorTokens(leaseDir);
    throw err;
  }
}

export async function clearCliConnectorTokens(
  leaseDir: BeneathDir,
): Promise<void> {
  const dir = leaseDir.child(CLI_CONNECTOR_DIR);
  for (const connector of CLI_CONNECTORS) {
    dir.unlink(tokenFile(connector));
  }
}

async function writeCliConnectorTokens(
  leaseDir: BeneathDir,
  tokens: CliConnectorTurnToken[],
): Promise<void> {
  const dir = leaseDir.child(CLI_CONNECTOR_DIR);
  const byConnector = new Map<CliConnector, string>();
  for (const { connector, token } of tokens) {
    if (CLI_CONNECTORS.includes(connector) && validToken(token)) {
      byConnector.set(connector, token);
    }
  }
  for (const connector of CLI_CONNECTORS) {
    const token = byConnector.get(connector);
    if (token == null) {
      dir.unlink(tokenFile(connector));
      continue;
    }
    dir.writeFile(tokenFile(connector), `${token}\n`, 0o600);
  }
}

// A live lease rewrites its token files every minute (renewal), so a token
// file untouched for this long belongs to a worker that died.
export const STALE_CLI_TOKEN_MS = 5 * 60_000;

/**
 * Remove token files left by dead runtime leases next to this one (worker or
 * host crash). Expiring provider tokens bound what is left in between.
 */
export async function sweepStaleCliConnectorTokens({
  runtimeDir,
  ownLeaseName,
  now = Date.now(),
}: {
  // The directory of the leases (in the project's scratch or home).
  runtimeDir: BeneathDir;
  ownLeaseName: string;
  now?: number;
}): Promise<number> {
  let removed = 0;
  let leases: string[];
  try {
    // Never through a symlink the project put on the way (it could point at
    // another project's): listing and every removal below refuse them.
    leases = await runtimeDir.list();
  } catch {
    return 0;
  }
  for (const lease of leases) {
    if (!lease.startsWith(".cocalc-agent-") || lease === ownLeaseName) continue;
    const dir = runtimeDir.child(lease).child(CLI_CONNECTOR_DIR);
    for (const connector of CLI_CONNECTORS) {
      try {
        const { kind, mtimeMs } = await dir.stat(tokenFile(connector));
        if (kind === "file" && now - mtimeMs > STALE_CLI_TOKEN_MS) {
          dir.unlink(tokenFile(connector));
          removed++;
        }
      } catch {
        // No such file, or not reachable without a symlink: nothing to sweep.
      }
    }
  }
  return removed;
}
