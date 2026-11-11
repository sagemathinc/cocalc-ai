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
  CLI_CONNECTOR_BIN_ENV,
  CLI_CONNECTORS,
  CLI_CONNECTOR_INFO,
  type CliConnector,
  type CliConnectorTurnToken,
} from "@cocalc/util/ai/cli-connectors";

export const CLI_CONNECTOR_DIR = "cli";

function tokenFile(connector: CliConnector): string {
  return `${connector}-token`;
}

// Said when a command fails without a token: agents otherwise take a plain
// auth failure (in a sensor script, say) for something else entirely.
function inactiveNote(command: string, connector: CliConnector): string {
  const label = CLI_CONNECTOR_INFO[connector].label;
  return `${command}: note: the CoCalc ${label} connector is not active here. It signs ${command} in only during a turn of an agent that has it turned on, not in sensors or background jobs.`;
}

// The real command is the first one on PATH that is not this wrapper.
function wrapperScript({
  command,
  envVar,
  connector,
  missing,
  statusArgs,
}: {
  command: string;
  envVar: string;
  connector: CliConnector;
  missing: string;
  // The arguments that ask who is signed in, e.g. "auth status".
  statusArgs: string;
}): string {
  const label = CLI_CONNECTOR_INFO[connector].label;
  return `#!/bin/sh
# CoCalc ${label} connector wrapper for ${command}.
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
  if [ "$*" = "${statusArgs}" ]; then
    echo "${command}: signed in via the CoCalc ${label} connector for this agent turn (${envVar})." >&2
  fi
  exec "$real" "$@"
fi
"$real" "$@"
status=$?
if [ "$status" -ne 0 ]; then
  echo "${inactiveNote(command, connector)}" >&2
fi
exit "$status"
`;
}

const GIT_CREDENTIAL_HELPER = `#!/bin/sh
# CoCalc GitHub connector: git credentials for https://github.com only.
# Other actions (store, erase) get the credential on stdin too: read it all
# before exiting, so the writer never meets a closed pipe.
[ "$1" = get ] || { cat >/dev/null; exit 0; }
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
  statusArgs: string;
}[] = [
  {
    name: "gh",
    connector: "github",
    envVar: "GH_TOKEN",
    missing: "Install GitHub's gh CLI.",
    statusArgs: "auth status",
  },
  {
    name: "cf",
    connector: "cloudflare",
    envVar: "CLOUDFLARE_API_TOKEN",
    missing:
      "Install it with: npm install -g --prefix ~/.local cf (the project needs internet access)",
    statusArgs: "whoami",
  },
  {
    name: "wrangler",
    connector: "cloudflare",
    envVar: "CLOUDFLARE_API_TOKEN",
    missing:
      "Install it with: npm install -g --prefix ~/.local wrangler (the project needs internet access)",
    statusArgs: "whoami",
  },
];

export const GIT_CREDENTIAL_HELPER_NAME = "git-credential-cocalc";

// git with the GitHub connector: only while a token is present, github.com
// credentials come from CoCalc alone. The empty helper resets every helper
// configured before it, so no other helper (e.g. "store") is asked to save
// the connector token. git@github.com: and ssh:// remotes (a usual origin)
// then go over https too: there is no SSH key for the connector. Without a
// token this runs git unchanged, and a failed remote command says why.
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
    -c "credential.https://github.com.helper=$self_dir/${GIT_CREDENTIAL_HELPER_NAME}" \\
    -c url.https://github.com/.insteadOf=git@github.com: \\
    -c url.https://github.com/.insteadOf=ssh://git@github.com/ "$@"
fi
"$real" "$@"
status=$?
if [ "$status" -ne 0 ]; then
  # The subcommand: the first argument after git's own options.
  sub=""
  skip=""
  for a in "$@"; do
    if [ -n "$skip" ]; then skip=""; continue; fi
    case "$a" in
      -C|-c|--git-dir|--work-tree|--namespace) skip=1 ;;
      -*) ;;
      *) sub=$a; break ;;
    esac
  done
  case "$sub" in
    push|pull|fetch|clone|ls-remote)
      echo "${inactiveNote("git", "github")}" >&2 ;;
  esac
fi
exit "$status"
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
  for (const { name, connector, envVar, missing, statusArgs } of WRAPPERS) {
    if (!connectors.includes(connector)) continue;
    bin.writeFile(
      name,
      wrapperScript({ command: name, envVar, connector, missing, statusArgs }),
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

// Puts the wrappers (gh, git, cf, wrangler) first on PATH, and names their
// directory in COCALC_CONNECTOR_BIN: a login shell's profile may reorder
// PATH, and commands (and agents) put it first again from that variable.
export function applyCliConnectorEnv(
  env: Record<string, string | undefined>,
  containerDir: string,
): void {
  const bin = join(containerDir, CLI_CONNECTOR_DIR, "bin");
  const path = `${env.PATH ?? ""}`
    .split(":")
    .filter((part) => part && part !== bin);
  env.PATH = [bin, ...path].join(":");
  env[CLI_CONNECTOR_BIN_ENV] = bin;
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
