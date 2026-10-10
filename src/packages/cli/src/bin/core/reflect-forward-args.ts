// Reflect decides the tunnel direction from endpoint order: the FIRST
// endpoint is the listener.  `local remote` runs `ssh -L` (a port on this
// machine reaches the project); `remote local` runs `ssh -R` (a port in the
// project reaches this machine).
export function projectToLocalForwardArgs({
  sshTarget,
  remotePort,
  localHost,
  localPort,
  name,
  compress,
}: {
  sshTarget: string;
  remotePort: number;
  localHost: string;
  localPort: number;
  name?: string;
  compress?: boolean;
}): string[] {
  const args = [
    "forward",
    "create",
    `${localHost}:${localPort}`,
    `${sshTarget}:${remotePort}`,
  ];
  if (name?.trim()) args.push("--name", name);
  if (compress) args.push("--compress");
  return args;
}
