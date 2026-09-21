/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { WorkspaceSshConnectionInfo } from "@cocalc/conat/hub/api/projects";

const CLOUDFLARED_PATH = '"$HOME/.local/share/cocalc/bin/cloudflared"';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockMarkers(alias: string): { start: string; end: string } {
  return {
    start: `# >>> cocalc project ssh ${alias} >>>`,
    end: `# <<< cocalc project ssh ${alias} <<<`,
  };
}

function directSshEndpoint(sshServer: string): {
  hostname: string;
  port?: number;
} {
  const value = sshServer.trim();
  const ipv6 = value.match(/^\[(.*)\]:(\d+)$/);
  if (ipv6) {
    return { hostname: ipv6[1], port: Number(ipv6[2]) };
  }
  const withPort = value.match(/^(.*):(\d+)$/);
  if (withPort) {
    return { hostname: withPort[1], port: Number(withPort[2]) };
  }
  return { hostname: value };
}

export function parseSshPublicKey(publicKey: string): {
  value: string;
  base64: string;
} {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2 || !parts[0].startsWith("ssh-") || !parts[1]) {
    throw new Error("The source project SSH public key is invalid.");
  }
  return { value: parts.join(" "), base64: parts[1] };
}

export function projectSshConfigBlock({
  alias,
  route,
}: {
  alias: string;
  route: Pick<
    WorkspaceSshConnectionInfo,
    "transport" | "ssh_username" | "ssh_server" | "cloudflare_hostname"
  >;
}): string {
  const markers = blockMarkers(alias);
  const lines = [`Host ${alias}`, `  User ${route.ssh_username}`];
  if (route.transport === "direct") {
    if (!route.ssh_server) {
      throw new Error("The target project has no direct SSH endpoint.");
    }
    const endpoint = directSshEndpoint(route.ssh_server);
    lines.splice(1, 0, `  HostName ${endpoint.hostname}`);
    if (endpoint.port != null) {
      lines.push(`  Port ${endpoint.port}`);
    }
  } else {
    const hostname = route.cloudflare_hostname?.trim();
    if (!hostname) {
      throw new Error("The target project has no Cloudflare SSH endpoint.");
    }
    lines.splice(1, 0, `  HostName ${hostname}`);
    lines.push(`  ProxyCommand ${CLOUDFLARED_PATH} access ssh --hostname %h`);
  }
  lines.push(
    "  StrictHostKeyChecking accept-new",
    "  ServerAliveInterval 15",
    "  ServerAliveCountMax 2",
    "  IdentityFile ~/.ssh/id_ed25519",
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  PreferredAuthentications publickey",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
  );
  return `${markers.start}\n${lines.join("\n")}\n${markers.end}\n`;
}

export function upsertProjectSshConfigBlock({
  content,
  alias,
  block,
}: {
  content: string;
  alias: string;
  block: string;
}): string {
  const markers = blockMarkers(alias);
  const pattern = new RegExp(
    `(?:^|\\n)${escapeRegExp(markers.start)}\\n[\\s\\S]*?\\n${escapeRegExp(markers.end)}(?:\\n|$)`,
    "g",
  );
  const stripped = content
    .replace(pattern, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return stripped ? `${stripped}\n\n${block}` : block;
}

export function removeProjectSshConfigBlock({
  content,
  alias,
}: {
  content: string;
  alias: string;
}): string {
  const markers = blockMarkers(alias);
  const pattern = new RegExp(
    `(?:^|\\n)${escapeRegExp(markers.start)}\\n[\\s\\S]*?\\n${escapeRegExp(markers.end)}(?:\\n|$)`,
    "g",
  );
  const stripped = content
    .replace(pattern, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return stripped ? `${stripped}\n` : "";
}

export const INSTALL_CLOUDFLARED_SCRIPT = `
set -euo pipefail
destination="$HOME/.local/share/cocalc/bin/cloudflared"
if [ -x "$destination" ]; then
  exit 0
fi
case "$(uname -m)" in
  x86_64|amd64) artifact="cloudflared-linux-amd64" ;;
  aarch64|arm64) artifact="cloudflared-linux-arm64" ;;
  *) echo "unsupported architecture for cloudflared: $(uname -m)" >&2; exit 1 ;;
esac
mkdir -p "$(dirname "$destination")"
tmp="\${destination}.tmp.$$"
trap 'rm -f "$tmp"' EXIT
curl -fsSL \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/\${artifact}" \
  -o "$tmp"
chmod 700 "$tmp"
mv "$tmp" "$destination"
trap - EXIT
`;
