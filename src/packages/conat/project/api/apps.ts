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
  statusApp: true,
  waitForAppState: true,
  ensureRunning: true,
  listAppStatuses: true,
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
  deleteApp: (id: string) => Promise<{ id: string; deleted: boolean; path: string }>;

  startApp: (id: string) => Promise<ManagedAppStatus>;
  stopApp: (id: string) => Promise<void>;
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
}
