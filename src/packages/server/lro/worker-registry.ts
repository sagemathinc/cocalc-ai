import { envToInt } from "@cocalc/backend/misc/env-to-number";

export type ParallelOpsWorkerCategory = "lro" | "cloud-work";
export type ParallelOpsScopeModel =
  | "global"
  | "per-provider"
  | "per-project-host";
export type ParallelOpsConfigSource = "constant" | "env-legacy";

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
  "host-upgrade-software",
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
    dynamic_limit_supported: false,
    lro_kinds: ["project-move"],
    lease_ms: 120_000,
    getLimitSnapshot: () => ({
      default_limit: 1,
      configured_limit: 1,
      effective_limit: 1,
      config_source: "constant",
    }),
  },
  {
    worker_kind: "project-restore",
    category: "lro",
    scope_model: "global",
    dynamic_limit_supported: false,
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
    worker_kind: "project-hard-delete",
    category: "lro",
    scope_model: "global",
    dynamic_limit_supported: false,
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
    dynamic_limit_supported: false,
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
    dynamic_limit_supported: false,
    lro_kinds: ["project-backup"],
    lease_ms: 120_000,
    notes: [
      "This reports the current hub-side admission cap only.",
      "Per-project-host backup execution slots are separate and not yet included in this status API.",
    ],
    getLimitSnapshot: () => {
      const configured = Math.max(
        1,
        Math.min(100, envToInt("COCALC_BACKUP_LRO_MAX_PARALLEL", 10)),
      );
      return {
        default_limit: 10,
        configured_limit: configured,
        effective_limit: configured,
        config_source: "env-legacy",
      };
    },
  },
  {
    worker_kind: "host-ops",
    category: "lro",
    scope_model: "global",
    dynamic_limit_supported: false,
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
    dynamic_limit_supported: false,
    notes: [
      "This reports the current cloud VM work queue caps, which are not stored in the LRO table.",
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
