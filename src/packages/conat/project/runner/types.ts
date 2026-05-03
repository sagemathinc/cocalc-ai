export type LocalPathFunction = (opts: {
  project_id: string;
  // disk quota to set on the path (in bytes)
  disk?: number;
  // optional explicit temporary-storage quota in bytes. Local btrfs runners
  // mount this volume at /tmp and may also expose a legacy /scratch alias.
  // set to 0 to disable the extra temporary-storage volume.
  scratch?: number;
  // if false, only resolve paths without creating volumes
  ensure?: boolean;
}) => Promise<{ home: string; scratch?: string }>;

export interface SshServer {
  name: string;
  host: string;
  port: number;
  user: string;
}

export type SshServersFunction = (opts: {
  project_id: string;
}) => Promise<SshServer[]>;

export interface Configuration {
  // optional Docker image
  image?: string;
  // optional host-side SSH port chosen by the caller; if omitted the runner
  // falls back to probing a free port locally.
  ssh_port?: number;
  // optional host-side HTTP proxy port chosen by the caller; if omitted the
  // runner falls back to probing a free port locally.
  http_port?: number;
  // SSH public key used by sshpiperd to reach the project container.
  ssh_proxy_public_key?: string;
  // shared secret between project and hubs to enhance security (via defense in depth)
  secret?: string;
  // Concatenated SSH public keys (from master) to be injected into the
  // project's managed authorized_keys file; combined with user-managed
  // ~/.ssh/authorized_keys at auth time.
  authorized_keys?: string;
  // extra variables that get merged into the environment of the project.
  env?: { [key: string]: string };
  // cpu priority: 1, 2 or 3, with 3 being highest
  cpu?: number;
  // memory limit in BYTES
  memory?: number;
  // swap -- enabled or not.  The actual amount is a function of
  // memory (above), RAM, and swap configuration on the runner itself -- see backend/podman/memory.ts
  swap?: boolean;
  // pid limit
  pids?: number;
  // disk size in bytes
  disk?: number;
  // if given, a disk-backed temporary volume of this size in bytes is mounted
  // at /tmp in the container. A legacy /scratch alias may also be mounted.
  scratch?: number;
  // optional explicit tmpfs size in bytes. Shared-host projects normally leave
  // this unset so /tmp uses the disk-backed temporary volume above instead of RAM.
  tmp?: number;
  // if true, allow GPU devices to be passed through (via CDI)
  gpu?: boolean;
  // backup restore behavior when starting a project on a host
  restore?: "none" | "auto" | "required";
  // LRO op_id to publish progress for project start.
  lro_op_id?: string;
}
