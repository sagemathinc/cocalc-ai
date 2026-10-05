/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Files that let an agent use gh, git and cf with a CLI connector token.
//
// Wrappers are written once per runtime lease and put first on PATH. Token
// files exist only while a turn of an agent with that connector turned on is
// running; without one, every wrapper just runs the real command unchanged.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
    missing: "Install Cloudflare's cf CLI.",
  },
  {
    name: "wrangler",
    connector: "cloudflare",
    envVar: "CLOUDFLARE_API_TOKEN",
    missing: "Install it with: npm install -g wrangler",
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

export async function writeCliConnectorTools(hostDir: string): Promise<void> {
  const dir = join(hostDir, CLI_CONNECTOR_DIR);
  const bin = join(dir, "bin");
  await fs.mkdir(bin, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await fs.chmod(bin, 0o700);
  for (const { name, connector, envVar, missing } of WRAPPERS) {
    await fs.writeFile(
      join(bin, name),
      wrapperScript({ command: name, envVar, connector, missing }),
      { mode: 0o700 },
    );
  }
  await fs.writeFile(
    join(bin, GIT_CREDENTIAL_HELPER_NAME),
    GIT_CREDENTIAL_HELPER,
    { mode: 0o700 },
  );
  await fs.writeFile(join(bin, "git"), GIT_WRAPPER, { mode: 0o700 });
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

// Makes the token files match exactly the given tokens.
export async function syncCliConnectorTokens(
  hostDir: string,
  tokens: CliConnectorTurnToken[],
): Promise<void> {
  const dir = join(hostDir, CLI_CONNECTOR_DIR);
  const byConnector = new Map<CliConnector, string>();
  for (const { connector, token } of tokens) {
    if (CLI_CONNECTORS.includes(connector) && validToken(token)) {
      byConnector.set(connector, token);
    }
  }
  for (const connector of CLI_CONNECTORS) {
    const path = join(dir, tokenFile(connector));
    const token = byConnector.get(connector);
    if (token == null) {
      await fs.rm(path, { force: true });
      continue;
    }
    const tempPath = join(dir, `.${connector}-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(tempPath, `${token}\n`, { mode: 0o600 });
      await fs.chmod(tempPath, 0o600);
      await fs.rename(tempPath, path);
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }
}
