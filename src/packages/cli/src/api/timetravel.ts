import { RefcountLeaseManager } from "@cocalc/util/refcount/lease";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";

export type TimeTravelWorkspaceIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

export type TimeTravelDocumentBindingOptions = {
  workspaceIdentifier?: string;
  path: string;
  cwd?: string;
};

export type TimeTravelDocumentDoctype = "syncstring" | "syncdb" | "immer";

type SyncDocDescriptor =
  | { doctype: "syncstring" }
  | {
      doctype: "syncdb" | "immer";
      primary_keys: string[];
      string_cols: string[];
    };

const EXTENSION_DOCTYPES: Record<string, SyncDocDescriptor> = {
  tasks: { doctype: "syncdb", primary_keys: ["task_id"], string_cols: ["desc"] },
  board: { doctype: "syncdb", primary_keys: ["id"], string_cols: ["str"] },
  slides: { doctype: "syncdb", primary_keys: ["id"], string_cols: ["str"] },
  chat: {
    doctype: "immer",
    primary_keys: ["date", "sender_id", "event", "message_id", "thread_id"],
    string_cols: ["input"],
  },
  "sage-chat": {
    doctype: "immer",
    primary_keys: ["date", "sender_id", "event", "message_id", "thread_id"],
    string_cols: ["input"],
  },
  "cocalc-crm": { doctype: "syncdb", primary_keys: ["table", "id"], string_cols: [] },
};

function filenameExtension(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

function getSyncDocDescriptor(path: string): SyncDocDescriptor {
  const ext = filenameExtension(path);
  if (ext && EXTENSION_DOCTYPES[ext]) return EXTENSION_DOCTYPES[ext];
  return { doctype: "syncstring" };
}

export type TimeTravelVersionRecord = {
  id: string;
  index: number;
  versionNumber: number | null;
  timestamp: string;
  timestampMs: number;
  wallTime: string | null;
  wallTimeMs: number | null;
  accountId: string | null;
  userId: number | null;
};

type SyncDocLike = {
  versions(): string[];
  patchTime(versionId: string): number | undefined;
  wallTime(versionId: string): number | undefined;
  historyVersionNumber(versionId: string): number | undefined;
  account_id(versionId: string): string | undefined;
  user_id(versionId: string): number;
  hasFullHistory(): boolean;
  loadMoreHistory(): Promise<void>;
  hasVersion(versionId: string): boolean;
  version(versionId: string): { to_str(): string };
  to_str(): string;
  historyLastVersion(): string | undefined;
  once(event: string, cb: (...args: any[]) => void): void;
  off(event: string, cb: (...args: any[]) => void): void;
  close(): void | Promise<void>;
};

type WithWorkspaceTimeTravelSession<Ctx, Workspace extends TimeTravelWorkspaceIdentity> = <T>(
  ctx: Ctx,
  options: TimeTravelDocumentBindingOptions,
  fn: (args: {
    workspace: Workspace;
    session: SyncDocLike;
    path: string;
    doctype: TimeTravelDocumentDoctype;
  }) => Promise<T>,
) => Promise<T>;

export interface BoundTimeTravelDocument<Workspace extends TimeTravelWorkspaceIdentity> {
  readonly workspaceIdentifier?: string;
  readonly path: string;
  readonly cwd?: string;

  listVersions(): Promise<{
    workspace: Workspace;
    path: string;
    doctype: TimeTravelDocumentDoctype;
    hasFullHistory: boolean;
    versions: TimeTravelVersionRecord[];
  }>;

  loadMoreHistory(): Promise<{
    workspace: Workspace;
    path: string;
    doctype: TimeTravelDocumentDoctype;
    hasFullHistory: boolean;
    versions: TimeTravelVersionRecord[];
  }>;

  readVersion(versionId: string): Promise<{
    workspace: Workspace;
    path: string;
    doctype: TimeTravelDocumentDoctype;
    version: TimeTravelVersionRecord;
    text: string;
  }>;

  readLive(): Promise<{
    workspace: Workspace;
    path: string;
    doctype: TimeTravelDocumentDoctype;
    text: string;
    latestVersionId: string | null;
  }>;

  withSession<T>(
    fn: (args: {
      workspace: Workspace;
      session: SyncDocLike;
      path: string;
      doctype: TimeTravelDocumentDoctype;
    }) => Promise<T>,
  ): Promise<T>;
}

export interface TimeTravelApi<Ctx, Workspace extends TimeTravelWorkspaceIdentity> {
  bindDocument(
    ctx: Ctx,
    options: TimeTravelDocumentBindingOptions,
  ): BoundTimeTravelDocument<Workspace>;
}

function toIsoOrNull(value: number | undefined): string | null {
  if (!(value != null && Number.isFinite(value))) return null;
  return new Date(value).toISOString();
}

function normalizeDocumentPath(path: string): string {
  const trimmed = `${path ?? ""}`.trim();
  if (!trimmed) throw new Error("document path is required");
  if (isAbsolute(trimmed)) return resolvePath(trimmed);
  return resolvePath(process.env.HOME?.trim() || process.cwd(), trimmed);
}

function versionRecord(
  session: SyncDocLike,
  versionId: string,
  index: number,
): TimeTravelVersionRecord {
  const timestampMs = session.patchTime(versionId) ?? 0;
  let wallTimeMs: number | null = null;
  let versionNumber: number | null = null;
  let accountId: string | null = null;
  let userId: number | null = null;
  try {
    wallTimeMs = session.wallTime(versionId) ?? null;
  } catch {}
  try {
    versionNumber = session.historyVersionNumber(versionId) ?? null;
  } catch {}
  try {
    accountId = session.account_id(versionId) ?? null;
  } catch {}
  try {
    userId = session.user_id(versionId);
  } catch {}
  return {
    id: versionId,
    index,
    versionNumber,
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    wallTime: toIsoOrNull(wallTimeMs ?? undefined),
    wallTimeMs,
    accountId,
    userId,
  };
}

function listVersionRecords(session: SyncDocLike): TimeTravelVersionRecord[] {
  const versions = session.versions() ?? [];
  return versions.map((id, index) => versionRecord(session, id, index));
}

export function createTimeTravelApi<Ctx, Workspace extends TimeTravelWorkspaceIdentity>({
  withWorkspaceTimeTravelSession,
}: {
  withWorkspaceTimeTravelSession: WithWorkspaceTimeTravelSession<Ctx, Workspace>;
}): TimeTravelApi<Ctx, Workspace> {
  function bindDocument(
    ctx: Ctx,
    options: TimeTravelDocumentBindingOptions,
  ): BoundTimeTravelDocument<Workspace> {
    const binding = {
      workspaceIdentifier: options.workspaceIdentifier,
      path: options.path,
      cwd: options.cwd,
    } as const;

    const withSession = async <T>(
      fn: (args: {
        workspace: Workspace;
        session: SyncDocLike;
        path: string;
        doctype: TimeTravelDocumentDoctype;
      }) => Promise<T>,
    ): Promise<T> =>
      await withWorkspaceTimeTravelSession(ctx, binding, fn);

    return {
      ...binding,
      async listVersions() {
        return await withSession(async ({ workspace, session, path, doctype }) => ({
          workspace,
          path,
          doctype,
          hasFullHistory: session.hasFullHistory(),
          versions: listVersionRecords(session),
        }));
      },
      async loadMoreHistory() {
        return await withSession(async ({ workspace, session, path, doctype }) => {
          await session.loadMoreHistory();
          return {
            workspace,
            path,
            doctype,
            hasFullHistory: session.hasFullHistory(),
            versions: listVersionRecords(session),
          };
        });
      },
      async readVersion(versionId: string) {
        return await withSession(async ({ workspace, session, path, doctype }) => {
          const versions = session.versions();
          const index = versions.indexOf(versionId);
          if (index === -1 || !session.hasVersion(versionId)) {
            throw new Error(`unknown or not-yet-loaded version '${versionId}'`);
          }
          const doc = session.version(versionId);
          return {
            workspace,
            path,
            doctype,
            version: versionRecord(session, versionId, index),
            text: doc.to_str(),
          };
        });
      },
      async readLive() {
        return await withSession(async ({ workspace, session, path, doctype }) => ({
          workspace,
          path,
          doctype,
          text: session.to_str(),
          latestVersionId: session.historyLastVersion() ?? null,
        }));
      },
      async withSession<T>(
        fn: (args: {
          workspace: Workspace;
          session: SyncDocLike;
          path: string;
          doctype: TimeTravelDocumentDoctype;
        }) => Promise<T>,
      ) {
        return await withSession(fn);
      },
    };
  }

  return { bindDocument };
}

export interface CreateTimeTravelSessionOptions {
  client: ConatClient;
  projectId: string;
  path: string;
  persistent?: boolean;
  fileUseInterval?: number;
  openTimeoutMs?: number;
}

export async function openTimeTravelSyncDoc({
  client,
  projectId,
  path,
  persistent,
  fileUseInterval,
  openTimeoutMs = 15_000,
}: CreateTimeTravelSessionOptions): Promise<{
  session: SyncDocLike;
  path: string;
  doctype: TimeTravelDocumentDoctype;
}> {
  const normalizedPath = normalizeDocumentPath(path);
  const descriptor = getSyncDocDescriptor(normalizedPath);
  const common = {
    project_id: projectId,
    path: normalizedPath,
    ...(persistent != null ? { persistent } : {}),
    ...(fileUseInterval != null ? { file_use_interval: fileUseInterval } : {}),
  };
  const session: SyncDocLike =
    descriptor.doctype === "syncstring"
      ? (client.sync.string(common as any) as unknown as SyncDocLike)
      : (client.sync.db({
          ...common,
          primary_keys: descriptor.primary_keys,
          string_cols: descriptor.string_cols,
        } as any) as unknown as SyncDocLike);

  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      session.off("ready", onReady);
      session.off("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err);
    };
    session.once("ready", onReady);
    session.once("error", onError);
    if (openTimeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `timeout waiting for TimeTravel session to become ready (${openTimeoutMs}ms)`,
          ),
        );
      }, openTimeoutMs);
    }
  });

  return {
    session,
    path: normalizedPath,
    doctype: descriptor.doctype,
  };
}

export function createLiveTimeTravelBinder<
  Ctx,
  Workspace extends TimeTravelWorkspaceIdentity,
>({
  resolveWorkspaceConatClient,
  openTimeoutMs = 15_000,
  leaseMs = 30_000,
}: {
  resolveWorkspaceConatClient: (
    ctx: Ctx,
    workspaceIdentifier?: string,
    cwd?: string,
  ) => Promise<{ workspace: Workspace; client: ConatClient }>;
  openTimeoutMs?: number;
  leaseMs?: number;
}): TimeTravelApi<Ctx, Workspace> {
  type Entry = {
    workspace: Workspace;
    session: SyncDocLike;
    path: string;
    doctype: TimeTravelDocumentDoctype;
  };
  const sessionPromises = new Map<string, Promise<Entry>>();
  const leases = new RefcountLeaseManager<string>({
    delayMs: leaseMs,
    disposer: async (key) => {
      const entryPromise = sessionPromises.get(key);
      sessionPromises.delete(key);
      if (!entryPromise) return;
      try {
        const entry = await entryPromise;
        await entry.session.close();
      } catch {
        // ignore cleanup failures
      }
    },
  });

  const withWorkspaceTimeTravelSession: WithWorkspaceTimeTravelSession<
    Ctx,
    Workspace
  > = async (ctx, options, fn) => {
    const { workspace, client } = await resolveWorkspaceConatClient(
      ctx,
      options.workspaceIdentifier,
      options.cwd,
    );
    const path = normalizeDocumentPath(options.path);
    const key = JSON.stringify({ project_id: workspace.project_id, path });
    const release = await leases.acquire(key);
    try {
      let entryPromise = sessionPromises.get(key);
      if (!entryPromise) {
        const created = (async () => {
          const opened = await openTimeTravelSyncDoc({
            client,
            projectId: workspace.project_id,
            path,
            persistent: true,
            fileUseInterval: 0,
            openTimeoutMs,
          });
          return { workspace, ...opened };
        })();
        sessionPromises.set(key, created);
        entryPromise = created;
        try {
          await created;
        } catch (error) {
          if (sessionPromises.get(key) === created) {
            sessionPromises.delete(key);
          }
          throw error;
        }
      }
      const entry = await entryPromise;
      return await fn(entry);
    } finally {
      await release();
    }
  };

  return createTimeTravelApi({ withWorkspaceTimeTravelSession });
}
