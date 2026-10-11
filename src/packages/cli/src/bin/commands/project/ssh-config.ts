import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function cloudflaredProxyCommand({
  cloudflared,
  hostname,
}: {
  cloudflared: string;
  hostname: string;
}): string {
  return `${shellQuote(cloudflared)} access ssh --hostname ${shellQuote(hostname)}`;
}

export function buildManagedProjectSshConfigLines({
  alias,
  hostName,
  username,
  proxyCommand,
  port,
  identityFile,
}: {
  alias: string;
  hostName: string;
  username: string;
  proxyCommand?: string | null;
  port?: number | null;
  identityFile?: string | null;
}): string[] {
  const lines = [
    `Host ${alias}`,
    `  HostName ${hostName}`,
    `  User ${username}`,
  ];
  if (proxyCommand) {
    lines.push(`  ProxyCommand ${proxyCommand}`);
  } else if (port != null) {
    lines.push(`  Port ${port}`);
  }
  // BatchMode prevents an interactive first-use prompt, so accept new keys
  // while continuing to reject changed keys.
  lines.push("  StrictHostKeyChecking accept-new");
  lines.push("  ServerAliveInterval 15");
  lines.push("  ServerAliveCountMax 2");
  if (identityFile) {
    lines.push(`  IdentityFile ${identityFile}`);
    lines.push("  IdentitiesOnly yes");
  }
  lines.push("  BatchMode yes");
  lines.push("  PreferredAuthentications publickey");
  lines.push("  PasswordAuthentication no");
  lines.push("  KbdInteractiveAuthentication no");
  return lines;
}

export function managedProjectSshOptionArgs(): string[] {
  return [
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "BatchMode=yes",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
  ];
}

export function managedProjectSshAlias(projectId: string): string {
  return `cocalc-project-${projectId}`;
}

// Write (or replace) the managed `Host <alias>` block that reflect-sync and
// plain ssh use to reach a project, via Cloudflare or the direct endpoint.
export function ensureManagedProjectSshConfigEntry({
  configPath,
  alias,
  route,
  keyPath,
  cloudflaredBinary,
  removeProjectSshConfigBlock,
  projectSshConfigBlockMarkers,
}: {
  configPath: string;
  alias: string;
  route: {
    ssh_transport: "cloudflare-tcp" | "cloudflare-access-tcp" | "direct";
    ssh_username: string;
    cloudflare_hostname: string | null;
    ssh_host: string | null;
    ssh_port: number | null;
  };
  keyPath: string | null;
  cloudflaredBinary: string | null;
  removeProjectSshConfigBlock: (
    content: string,
    alias: string,
  ) => { content: string };
  projectSshConfigBlockMarkers: (alias: string) => {
    start: string;
    end: string;
  };
}): void {
  const hostName =
    route.ssh_transport !== "direct"
      ? `${route.cloudflare_hostname ?? ""}`.trim()
      : `${route.ssh_host ?? ""}`.trim();
  if (!hostName) {
    throw new Error("project ssh route is missing host endpoint");
  }
  let proxyCommand: string | null = null;
  if (route.ssh_transport !== "direct") {
    if (!cloudflaredBinary) {
      throw new Error(
        "cloudflared is required for managed Cloudflare SSH forwarding",
      );
    }
    proxyCommand = cloudflaredProxyCommand({
      cloudflared: cloudflaredBinary,
      hostname: "%h",
    });
  }
  const lines = buildManagedProjectSshConfigLines({
    alias,
    hostName,
    username: route.ssh_username,
    proxyCommand,
    port: route.ssh_transport === "direct" ? route.ssh_port : null,
    identityFile: keyPath,
  });

  const markers = projectSshConfigBlockMarkers(alias);
  const block = `${markers.start}\n${lines.join("\n")}\n${markers.end}\n`;
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const existing = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : "";
  const stripped = removeProjectSshConfigBlock(
    existing,
    alias,
  ).content.trimEnd();
  const next = stripped ? `${stripped}\n\n${block}` : block;
  writeFileSync(configPath, next, { encoding: "utf8", mode: 0o600 });
}
