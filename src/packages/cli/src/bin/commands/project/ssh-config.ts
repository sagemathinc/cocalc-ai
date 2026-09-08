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
