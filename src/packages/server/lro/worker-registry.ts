import { envToInt } from "@cocalc/backend/misc/env-to-number";

export type ParallelOpsWorkerCategory = "lro" | "cloud-work" | "host-local";
export type ParallelOpsScopeModel =
  | "global"
  | "per-provider"
  | "per-project-host";
export type ParallelOpsConfigSource =
  | "constant"
  | "env-legacy"
  | "db-override"
  | "env-debug-cap";

export interface ParallelOpsLimitSnapshot {
  default_limit: number | null;
  configured_limit: number | null;
  effective_limit: number | null;
  config_source: ParallelOpsConfigSource;
  extra_limits?: Record<string, number>;
}

export interface ParallelOpsWorkerRegistration {
  worker_kind: string;
  category: ParallelOpsWorkerCategory;
  scope_model: ParallelOpsScopeModel;
  dynamic_limit_supported: boolean;
  notes?: string[];
  lro_kinds?: string[];
  lease_ms?: number;
  getLimitSnapshot: () => ParallelOpsLimitSnapshot;
}

const HOST_OP_LRO_KINDS = [
  "host-start",
  "host-stop",
  "host-restart",
  "host-drain",
  "host-reconcile-software",
  "host-upgrade-software",
  "host-rollout-managed-components",
  "host-deprovision",
  "host-delete",
  "host-force-deprovision",
  "host-remove-connector",
] as const;

export const parallelOpsWorkerRegistry: ParallelOpsWorkerRegistration[] = [
  {
    worker_kind: "project-move",
    category: "lro",
    scope_model: "global",
    dynamic_limit_supported: true,
    lro_kinds: ["project-move"],
    lease_ms: 120_000,
    notes: [
      "This is the global project-move admission cap.",
      "Per-source-host and per-destination-host move limits are reported separately.",
    ],
    getLimitSnapshot: () => ({
      default_limit: 1,
      configured_limit: 1,
      effective_limit: 1,
      config_source: "constant",
    }),
  },
  {
    worker_kind: "project-move-source-host",
    category: "lro",
    scope_model: "per-project-host",
    dynamic_limit_supported: true,
    lease_ms: 120_000,
    notes: [
      "This reports source-host involvement in project-move admission.",
      "running_count and queued_count here count moves by source host, not separate worker processes.",
    ],
    getLimitSnapshot: () => ({
      default_limit: 1,
      configured_limit: null,
      effective_limit: null,
      config_source: "constant",
    }),
  },
  {
    worker_kind: "project-move-destination-host",
    category: "lro",
    scope_model: "per-project-host",
    dynamic_limit_supported: true,
    lease_ms: 120_000,
    notes: [
      "This reports destination-host involvement in project-move admission.",
      "Queued moves without a selected destination are tracked under the 'unassigned' breakdown key.",
    ],
    getLimitSnapshot: () => ({
      default_limit: 1,
      configured_limit: null,
      effective_limit: null,
      config_source: "constant",
    }),
  },
  {
    worker_kind: "project-restore",
    category: "lro",
    scope_model: "global",
    dynamic_limit_supported: true,
    lro_kinds: ["project-restore"],
    lease_ms: 120_000,
    getLimitSnapshot: () => ({
      default_limit: 1,
      configured_limit: 1,
      effective_limit: 1,
      config_source: "constant",
    }),
  },
  {
    worker_kind: "project-rootfs-publish",
    category: "lro",
    scope_model: "global",
    dynamic_limit_supported: true,
    lro_kinds: ["project-rootfs-publish"],
    lease_ms: 120_000,
    notes: [
      "This is the global RootFS publish admission cap.",
      "Per-project-host RootFS publish limits are reported separately.",
    ],
    getLimitSnapshot: () => ({
      default_limit: 250,
      configured_limit: 250,
      effective_limit: 250,
      config_source: "constant",
    }),
  },
  {
    worker_kind: "project-rootfs-publish-host",
    category: "lro",
    scope_model: "per-project-host",
    dynamic_limit_supported: true,
    lease_ms: 120_000,
    notes: [
      "This reports host-local admission usage for RootFS publish.",
      "The effective per-host default is CPU-based and can be overridden per host.",
    ],
    getLimitSnapshot: () => ({
      default_limit: 1,
      configured_limit: null,
      effective_limit: null,
      config_source: "constant",
    }),
  },
  {
    worker_kind: "project-hard-delete",
    category: "lro",
    scope_model: "global",
    dynamic_limit_supported: true,
    lro_kinds: ["project-hard-delete"],
    lease_ms: 120_000,
    getLimitSnapshot: () => ({
      default_limit: 1,
      configured_limit: 1,
      effective_limit: 1,
      config_source: "constant",
    }),
  },
  {
    worker_kind: "copy-path-between-projects",
    category: "lro",
    scope_model: "global",
    dynamic_limit_supported: true,
    lro_kinds: ["copy-path-between-projects"],
    lease_ms: 120_000,
    getLimitSnapshot: () => ({
      default_limit: 2,
      configured_limit: 2,
      effective_limit: 2,
      config_source: "constant",
    }),
  },
  {
    worker_kind: "project-backup",
    category: "lro",
    scope_model: "global",
    dynamic_limit_supported: true,
    lro_kinds: ["project-backup"],
    lease_ms: 120_000,
    notes: [
      "This reports the current hub-side admission cap only.",
      "Per-project-host backup execution slots are separate and not yet included in this status API.",
    ],
    getLimitSnapshot: () => {
      const configured = Math.max(
        1,
        Math.min(250, envToInt("COCALC_BACKUP_LRO_MAX_PARALLEL", 250)),
      );
      return {
        default_limit: 250,
        configured_limit: configured,
        effective_limit: configured,
        config_source: "env-legacy",
      };
    },
  },
  {
    worker_kind: "project-host-backup-execution",
    category: "host-local",
    scope_model: "per-project-host",
    dynamic_limit_supported: true,
    notes: [
      "This reports host-local backup slot usage on reachable project-hosts.",
      "running_count is the number of backup slots in use, and queued_count is the number of host-local waiters.",
      "The effective per-host default is CPU-based and can be overridden per host.",
    ],
    getLimitSnapshot: () => ({
      default_limit: 1,
      configured_limit: null,
      effective_limit: null,
      config_source: "env-legacy",
    }),
  },
  {
    worker_kind: "host-ops",
    category: "lro",
    scope_model: "global",
    dynamic_limit_supported: true,
    lro_kinds: [...HOST_OP_LRO_KINDS],
    lease_ms: 120_000,
    getLimitSnapshot: () => ({
      default_limit: 2,
      configured_limit: 2,
      effective_limit: 2,
      config_source: "constant",
    }),
  },
  {
    worker_kind: "cloud-vm-work",
    category: "cloud-work",
    scope_model: "per-provider",
    dynamic_limit_supported: true,
    notes: [
      "This reports the current cloud VM work queue caps.",
      "The global worker limit and per-provider caps can both be overridden live.",
    ],
    getLimitSnapshot: () => ({
      default_limit: 10,
      configured_limit: 10,
      effective_limit: 10,
      config_source: "constant",
      extra_limits: {
        per_provider_limit: 10,
      },
    }),
  },
];

export const parallelOpsWorkerRegistryByKind = new Map(
  parallelOpsWorkerRegistry.map((entry) => [entry.worker_kind, entry]),
);

export const parallelOpsWorkerKinds = parallelOpsWorkerRegistry.map(
  ({ worker_kind }) => worker_kind,
);

export const parallelOpsLroKindToWorkerKind = new Map<string, string>(
  parallelOpsWorkerRegistry.flatMap((entry) =>
    (entry.lro_kinds ?? []).map((kind) => [kind, entry.worker_kind] as const),
  ),
);

export function getParallelOpsWorkerRegistration(worker_kind: string) {
  return parallelOpsWorkerRegistryByKind.get(worker_kind);
}
