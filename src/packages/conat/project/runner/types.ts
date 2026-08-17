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
  // if true and scratch is enabled, recreate the non-backed-up temporary
  // storage volume before returning its path.
  resetScratch?: boolean;
  // if false, the project host already applied authoritative volume quotas.
  applyQuota?: boolean;
}) => Promise<{ home: string; scratch?: string; quota_applied?: boolean }>;

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
  // Project secrets mounted read-only at COCALC_SECRETS in the runtime.
  secrets?: { [key: string]: string };
  // Authoritative generation represented by the complete secrets map.
  secrets_generation?: number;
  // hard CPU limit measured in cores
  cpu?: number;
  // relative, work-conserving CPU scheduling priority
  cpu_priority?: number;
  // Authoritative storage service class resolved by the owning bay. Unknown
  // or missing values are treated as the safest normal shared-host class.
  io_class?: "standard" | "member" | "premium";
  // memory limit in BYTES
  memory?: number;
  // swap -- enabled or not.  The actual amount is a function of
  // memory (above), RAM, and swap configuration on the runner itself -- see backend/podman/memory.ts
  swap?: boolean;
  // pid limit
  pids?: number;
  // open file descriptor limit, applied as both soft and hard RLIMIT_NOFILE.
  nofile?: number;
  // core dump size limit, applied as both soft and hard RLIMIT_CORE.
  core?: number;
  // podman shared memory size, e.g. "64m".
  shmSize?: string;
  // disk size in bytes
  disk?: number;
  // if given, a disk-backed temporary volume of this size in bytes is mounted
  // at /tmp in the container. A legacy /scratch alias may also be mounted.
  scratch?: number;
  // The project host has durably applied the authoritative home and scratch
  // quota revision. The runner must not independently rewrite those limits.
  storage_quota_prepared?: boolean;
  // The project host has reset and prepared scratch for this cold start.
  scratch_prepared?: boolean;
  // optional explicit tmpfs size in bytes. Shared-host projects normally leave
  // this unset so /tmp uses the disk-backed temporary volume above instead of RAM.
  tmp?: number;
  // if true, allow GPU devices to be passed through (via CDI)
  gpu?: boolean;
  // backup restore behavior when starting a project on a host
  // "recover" restores the latest backup even if an incidental local volume
  // was created before start, but still permits a project with no backups.
  restore?: "none" | "auto" | "recover" | "required";
  // optional explicit backup id to restore instead of resolving "latest"
  restore_backup_id?: string;
  // LRO op_id to publish progress for project start.
  lro_op_id?: string;
}
