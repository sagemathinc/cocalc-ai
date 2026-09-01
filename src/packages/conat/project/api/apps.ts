import type { AppTemplateCatalogEntryV1 } from "@cocalc/util/apps/template-catalog";
import type {
  ProjectAppPrivateHostnamePolicy,
  ProjectAppPrivateHostnameRecord,
} from "@cocalc/conat/hub/api/system";

export const apps = {
  start: true,
  stop: true,
  status: true,
  waitForState: true,
  listAppSpecs: true,
  getAppSpec: true,
  upsertAppSpec: true,
  deleteApp: true,
  startApp: true,
  stopApp: true,
  refreshApp: true,
  statusApp: true,
  waitForAppState: true,
  ensureRunning: true,
  listAppStatuses: true,
  getPrivateHostnamePolicy: true,
  inspectPrivateHostname: true,
  listPrivateHostnames: true,
  reservePrivateHostname: true,
  releasePrivateHostname: true,
  appLogs: true,
  appMetrics: true,
  listAppMetrics: true,
  detectApps: true,
  detectInstalledTemplates: true,
  listAppTemplates: true,
};

export interface NamedServerStatus {
  state: "running" | "stopped";
  port?: number;
  url?: string;
  ready?: boolean;
  pid?: number;
  stdout?: Buffer;
  stderr?: Buffer;
  spawnError?;
  exit?: { code; signal? };
}

export interface AppSpec {
  version: 1;
  id: string;
  title?: string;
  kind: "service" | "static";
  [key: string]: any;
}

export interface AppSpecRecord {
  id: string;
  path: string;
  mtime?: number;
  spec?: AppSpec;
  error?: string;
}

export interface ManagedAppStatus {
  id: string;
  state: "running" | "stopped";
  kind?: "service" | "static";
  lifecycle_mode?: "managed" | "unmanaged";
  title?: string;
  path?: string;
  mtime?: number;
  port?: number;
  url?: string;
  ready?: boolean;
  pid?: number;
  stdout?: Buffer;
  stderr?: Buffer;
  spawnError?: unknown;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  error?: string;
  warnings?: string[];
}

export interface DetectedAppPort {
  port: number;
  hosts: string[];
  managed: boolean;
  managed_app_ids: string[];
  proxy_url: string;
  source: "ss" | "lsof" | "procfs";
}

export interface InstalledAppTemplate {
  key: string;
  label: string;
  available: boolean;
  status?: "available" | "missing" | "unknown";
  details?: string;
}

export interface AppTemplateCatalogEntry extends AppTemplateCatalogEntryV1 {
  template_source?: string;
  template_scope?: "builtin" | "remote" | "project-local";
  source_path?: string;
}

export interface AppMetricsBucket {
  minute_start_ms: number;
  requests: number;
  bytes_sent: number;
  bytes_received: number;
  websocket_bytes_sent: number;
  public_requests: number;
  private_requests: number;
  websocket_upgrades: number;
}

export interface AppMetricsSummary {
  app_id: string;
  active_websockets: number;
  last_hit_ms?: number;
  totals: {
    requests: number;
    bytes_sent: number;
    bytes_received: number;
    public_requests: number;
    private_requests: number;
    public_bytes_sent: number;
    private_bytes_sent: number;
    status_2xx: number;
    status_3xx: number;
    status_4xx: number;
    status_5xx: number;
    websocket_upgrades: number;
    websocket_bytes_sent: number;
    wake_count: number;
    latency_count: number;
    latency_sum_ms: number;
    latency_max_ms: number;
    p50_ms?: number;
    p95_ms?: number;
  };
  history: AppMetricsBucket[];
}

export interface Apps {
  start: (name: string) => Promise<NamedServerStatus>;

  status: (name: string) => Promise<NamedServerStatus>;

  waitForState: (
    name: string,
    state: "running" | "stopped",
    opts?: { timeout?: number; interval?: number },
  ) => Promise<boolean>;

  stop: (name: string) => Promise<void>;

  listAppSpecs: () => Promise<AppSpecRecord[]>;
  getAppSpec: (id: string) => Promise<AppSpec>;
  upsertAppSpec: (
    spec: unknown,
  ) => Promise<{ id: string; path: string; spec: AppSpec }>;
  deleteApp: (
    id: string,
  ) => Promise<{ id: string; deleted: boolean; path: string }>;

  startApp: (id: string) => Promise<ManagedAppStatus>;
  stopApp: (id: string) => Promise<void>;
  refreshApp: (id: string) => Promise<ManagedAppStatus>;
  statusApp: (id: string) => Promise<ManagedAppStatus>;
  waitForAppState: (
    id: string,
    state: "running" | "stopped",
    opts?: { timeout?: number; interval?: number },
  ) => Promise<boolean>;
  ensureRunning: (
    id: string,
    opts?: { timeout?: number; interval?: number },
  ) => Promise<ManagedAppStatus>;
  listAppStatuses: () => Promise<ManagedAppStatus[]>;
  getPrivateHostnamePolicy: () => Promise<ProjectAppPrivateHostnamePolicy>;
  inspectPrivateHostname: (
    id: string,
  ) => Promise<ProjectAppPrivateHostnameRecord | undefined>;
  listPrivateHostnames: () => Promise<ProjectAppPrivateHostnameRecord[]>;
  reservePrivateHostname: (
    id: string,
  ) => Promise<ProjectAppPrivateHostnameRecord>;
  releasePrivateHostname: (id: string) => Promise<{ released: boolean }>;
  appLogs: (id: string) => Promise<{
    id: string;
    state: "running" | "stopped";
    stdout: string;
    stderr: string;
  }>;
  appMetrics: (
    id: string,
    opts?: { minutes?: number },
  ) => Promise<AppMetricsSummary>;
  listAppMetrics: (opts?: { minutes?: number }) => Promise<AppMetricsSummary[]>;

  detectApps: (opts?: {
    include_managed?: boolean;
    limit?: number;
    http_only?: boolean;
  }) => Promise<DetectedAppPort[]>;

  detectInstalledTemplates: () => Promise<InstalledAppTemplate[]>;
  listAppTemplates: () => Promise<AppTemplateCatalogEntry[]>;
}
