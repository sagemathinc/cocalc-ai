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

// The project listens on 127.0.0.1:projectPort and connects back to a port on
// this machine.  Always loopback-only: project sshd allows remote binds on all
// interfaces, and what we forward (e.g. a browser's DevTools port) must only be
// reachable from inside the project.
export function localToProjectForwardArgs({
  sshTarget,
  projectPort,
  localPort,
  name,
  compress,
}: {
  sshTarget: string;
  projectPort: number;
  localPort: number;
  name?: string;
  compress?: boolean;
}): string[] {
  const args = [
    "forward",
    "create",
    `${sshTarget}:${projectPort}`,
    `127.0.0.1:${localPort}`,
    "--remote-bind",
    "127.0.0.1",
  ];
  if (name?.trim()) args.push("--name", name);
  if (compress) args.push("--compress");
  return args;
}

// `forward create --help` text from the installed reflect-sync.
export function reflectSupportsRemoteBind(createHelp: string): boolean {
  return /--remote-bind\b/.test(createHelp);
}
