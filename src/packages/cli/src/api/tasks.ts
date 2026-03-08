import type {
  OpenTasksSessionOptions,
  TaskCreateInput,
  TaskMutableFields,
  TaskQuery,
  TaskRecord,
  TasksSession,
} from "@cocalc/app-tasks";
import { openSyncDBTasksSession } from "@cocalc/app-tasks";
import { connect as connectConat, type Client as ConatClient } from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";
import { isValidUUID } from "@cocalc/util/misc";
import { RefcountLeaseManager } from "@cocalc/util/refcount/lease";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { normalizeUrl } from "../core/utils";

type WorkspaceIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

type TasksDocumentBindingOptions = {
  workspaceIdentifier?: string;
  path: string;
  cwd?: string;
};

type WithWorkspaceTasksSession<Ctx, Workspace extends WorkspaceIdentity> = <T>(
  ctx: Ctx,
  options: TasksDocumentBindingOptions & {
    readOnly?: boolean;
  },
  fn: (args: {
    workspace: Workspace;
    session: TasksSession;
    path: string;
  }) => Promise<T>,
) => Promise<T>;

export interface OpenTasksApiOptions {
  apiBaseUrl?: string;
  bearer?: string;
  projectId?: string;
  timeoutMs?: number;
  sessionOpenTimeoutMs?: number;
}

export interface OpenedTasksApi extends TasksApi<undefined, WorkspaceIdentity> {
  readonly workspace: WorkspaceIdentity;
  readonly apiBaseUrl: string;
  close(): Promise<void>;
}

export interface BoundTasksDocument<Workspace extends WorkspaceIdentity> {
  readonly workspaceIdentifier?: string;
  readonly path: string;
  readonly cwd?: string;

  getSnapshot(query?: TaskQuery): Promise<{
    workspace: Workspace;
    path: string;
    tasks: TaskRecord[];
    revision?: string | number | null;
  }>;

  getTask(taskId: string): Promise<{
    workspace: Workspace;
    path: string;
    task?: TaskRecord;
  }>;

  setDone(taskId: string, done: boolean): Promise<{
    workspace: Workspace;
    path: string;
    changedTaskIds: readonly string[];
    revision?: string | number | null;
    task?: TaskRecord;
  }>;

  appendToDescription(taskId: string, text: string): Promise<{
    workspace: Workspace;
    path: string;
    changedTaskIds: readonly string[];
    revision?: string | number | null;
    task?: TaskRecord;
  }>;

  updateTask(taskId: string, changes: Partial<TaskMutableFields>): Promise<{
    workspace: Workspace;
    path: string;
    changedTaskIds: readonly string[];
    revision?: string | number | null;
    task?: TaskRecord;
  }>;

  createTask(input?: TaskCreateInput): Promise<{
    workspace: Workspace;
    path: string;
    task: TaskRecord;
  }>;

  withSession<T>(
    fn: (args: {
      workspace: Workspace;
      session: TasksSession;
      path: string;
    }) => Promise<T>,
  ): Promise<T>;
}

export interface TasksApi<Ctx, Workspace extends WorkspaceIdentity> {
  bindDocument(
    ctx: Ctx,
    options: TasksDocumentBindingOptions,
  ): BoundTasksDocument<Workspace>;
}

export function createTasksApi<Ctx, Workspace extends WorkspaceIdentity>({
  withWorkspaceTasksSession,
}: {
  withWorkspaceTasksSession: WithWorkspaceTasksSession<Ctx, Workspace>;
}): TasksApi<Ctx, Workspace> {
  function bindDocument(
    ctx: Ctx,
    options: TasksDocumentBindingOptions,
  ): BoundTasksDocument<Workspace> {
    const binding = {
      workspaceIdentifier: options.workspaceIdentifier,
      path: options.path,
      cwd: options.cwd,
    } as const;

    const withSession = async <T>(
      fn: (args: {
        workspace: Workspace;
        session: TasksSession;
        path: string;
      }) => Promise<T>,
      readOnly?: boolean,
    ): Promise<T> =>
      await withWorkspaceTasksSession(
        ctx,
        {
          workspaceIdentifier: binding.workspaceIdentifier,
          path: binding.path,
          cwd: binding.cwd,
          ...(readOnly ? { readOnly: true } : {}),
        },
        fn,
      );

    return {
      ...binding,
      async getSnapshot(query?: TaskQuery) {
        return await withSession(
          async ({ workspace, session, path }) => {
            const snapshot = await session.getSnapshot(query);
            return {
              workspace,
              path,
              tasks: [...snapshot.tasks],
              revision: snapshot.revision ?? null,
            };
          },
          true,
        );
      },
      async getTask(taskId: string) {
        return await withSession(
          async ({ workspace, session, path }) => ({
            workspace,
            path,
            task: await session.getTask(taskId),
          }),
          true,
        );
      },
      async setDone(taskId: string, done: boolean) {
        return await withSession(async ({ workspace, session, path }) => {
          const result = await session.setDone(taskId, done);
          return {
            workspace,
            path,
            changedTaskIds: result.changedTaskIds,
            revision: result.revision ?? null,
            task: await session.getTask(taskId),
          };
        });
      },
      async appendToDescription(taskId: string, text: string) {
        return await withSession(async ({ workspace, session, path }) => {
          const result = await session.appendToDescription(taskId, text);
          return {
            workspace,
            path,
            changedTaskIds: result.changedTaskIds,
            revision: result.revision ?? null,
            task: await session.getTask(taskId),
          };
        });
      },
      async updateTask(taskId: string, changes: Partial<TaskMutableFields>) {
        return await withSession(async ({ workspace, session, path }) => {
          const result = await session.updateTask(taskId, changes);
          return {
            workspace,
            path,
            changedTaskIds: result.changedTaskIds,
            revision: result.revision ?? null,
            task: await session.getTask(taskId),
          };
        });
      },
      async createTask(input?: TaskCreateInput) {
        return await withSession(async ({ workspace, session, path }) => ({
          workspace,
          path,
          task: await session.createTask(input),
        }));
      },
      async withSession<T>(
        fn: (args: {
          workspace: Workspace;
          session: TasksSession;
          path: string;
        }) => Promise<T>,
      ) {
        return await withSession(fn);
      },
    };
  }

  return { bindDocument };
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_SESSION_LEASE_MS = 30_000;

type LiteConnectionInfo = {
  url?: string;
  protocol?: string;
  host?: string;
  port?: number;
  agent_token?: string;
};

function defaultApiBaseUrl(): string {
  const fromEnv = process.env.COCALC_API_URL ?? process.env.BASE_URL;
  if (fromEnv?.trim()) {
    return normalizeUrl(fromEnv);
  }
  const raw = `http://127.0.0.1:${process.env.HUB_PORT ?? process.env.PORT ?? "9100"}`;
  return normalizeUrl(raw);
}

function isLoopbackHostName(hostname: string): boolean {
  const host = `${hostname ?? ""}`.trim().toLowerCase();
  if (!host) return false;
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function liteConnectionInfoPath(): string {
  const explicit =
    process.env.COCALC_LITE_CONNECTION_INFO ??
    process.env.COCALC_WRITE_CONNECTION_INFO;
  if (explicit?.trim()) return explicit.trim();
  return resolvePath(
    process.env.HOME?.trim() || process.cwd(),
    ".local/share/cocalc-lite/connection-info.json",
  );
}

function loadLiteConnectionInfo(): LiteConnectionInfo | undefined {
  try {
    const path = liteConnectionInfoPath();
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as LiteConnectionInfo;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function matchesLiteConnection(apiBaseUrl: string, info: LiteConnectionInfo): boolean {
  if (typeof info.url === "string" && info.url.trim()) {
    try {
      return normalizeUrl(info.url) === apiBaseUrl;
    } catch {
      // ignore malformed url
    }
  }
  try {
    const base = new URL(apiBaseUrl);
    const hostOk =
      typeof info.host === "string" &&
      info.host.trim().toLowerCase() === base.hostname.toLowerCase();
    const protocolOk =
      typeof info.protocol === "string"
        ? info.protocol.trim().toLowerCase().replace(/:$/, "") ===
          base.protocol.replace(/:$/, "").toLowerCase()
        : true;
    const port = Number(info.port ?? NaN);
    const basePort = Number(base.port || (base.protocol === "https:" ? 443 : 80));
    const portOk = Number.isFinite(port) ? port === basePort : true;
    return hostOk && protocolOk && portOk;
  } catch {
    return false;
  }
}

function normalizeTasksPath(path: string): string {
  const trimmed = `${path ?? ""}`.trim();
  if (!trimmed) {
    throw new Error("tasks path is required");
  }
  if (isAbsolute(trimmed)) {
    return resolvePath(trimmed);
  }
  return resolvePath(process.env.HOME?.trim() || process.cwd(), trimmed);
}

async function openCurrentProjectConatClient({
  apiBaseUrl,
  bearer,
  timeoutMs,
  projectId,
}: {
  apiBaseUrl: string;
  bearer: string;
  timeoutMs: number;
  projectId: string;
}): Promise<ConatClient> {
  const client = connectConat({
    address: apiBaseUrl,
    noCache: true,
    auth: async (cb) =>
      cb({
        bearer,
        project_id: projectId,
      }),
  });
  client.inboxPrefixHook = (info) => {
    const user = info?.user as
      | {
          account_id?: string;
          project_id?: string;
          hub_id?: string;
          host_id?: string;
        }
      | undefined;
    if (!user) return undefined;
    return inboxPrefix({
      account_id: user.account_id,
      project_id: user.project_id,
      hub_id: user.hub_id,
      host_id: user.host_id,
    });
  };
  try {
    await client.waitUntilSignedIn({ timeout: timeoutMs });
    return client;
  } catch (error) {
    try {
      client.close();
    } catch {
      // ignore cleanup failures
    }
    throw error;
  }
}

export async function openTasksApi(
  options: OpenTasksApiOptions = {},
): Promise<OpenedTasksApi> {
  const apiBaseUrl = options.apiBaseUrl
    ? normalizeUrl(options.apiBaseUrl)
    : defaultApiBaseUrl();
  let bearer = `${options.bearer ?? process.env.COCALC_BEARER_TOKEN ?? process.env.COCALC_AGENT_TOKEN ?? ""}`.trim();
  if (!bearer) {
    let hostname = "";
    try {
      hostname = new URL(apiBaseUrl).hostname;
    } catch {
      hostname = "";
    }
    if (isLoopbackHostName(hostname)) {
      const info = loadLiteConnectionInfo();
      if (info?.agent_token?.trim() && matchesLiteConnection(apiBaseUrl, info)) {
        bearer = info.agent_token.trim();
      }
    }
  }
  if (!bearer) {
    throw new Error(
      "openTasksApi requires a bearer token; set COCALC_BEARER_TOKEN or pass options.bearer",
    );
  }
  const projectId = `${options.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
  if (!isValidUUID(projectId)) {
    throw new Error(
      "openTasksApi requires the current project id; set COCALC_PROJECT_ID or pass options.projectId",
    );
  }

  const workspace: WorkspaceIdentity = {
    project_id: projectId,
    title: projectId,
    host_id: null,
  };
  const client = await openCurrentProjectConatClient({
    apiBaseUrl,
    bearer,
    timeoutMs: options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    projectId,
  });

  const sessionPromises = new Map<
    string,
    Promise<{ workspace: WorkspaceIdentity; session: TasksSession; path: string }>
  >();
  let closed = false;
  const sessionLeases = new RefcountLeaseManager<string>({
    delayMs: DEFAULT_SESSION_LEASE_MS,
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

  const withWorkspaceTasksSession: WithWorkspaceTasksSession<
    undefined,
    WorkspaceIdentity
  > = async (ctx, docOptions, fn) => {
    void ctx;
    if (closed) {
      throw new Error("tasks api is closed");
    }
    const path = normalizeTasksPath(docOptions.path);
    const key = JSON.stringify({
      project_id: projectId,
      path,
      readOnly: docOptions.readOnly === true,
    });
    const release = await sessionLeases.acquire(key);
    try {
      let entryPromise = sessionPromises.get(key);
      if (!entryPromise) {
        const created = (async () => {
          const session = await openSyncDBTasksSession({
            client,
            projectId,
            path,
            readOnly: docOptions.readOnly,
            openTimeoutMs:
              options.sessionOpenTimeoutMs ?? DEFAULT_SESSION_OPEN_TIMEOUT_MS,
          } satisfies OpenTasksSessionOptions & {
            client: ConatClient;
          });
          return { workspace, session, path };
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

  const api = createTasksApi<undefined, WorkspaceIdentity>({
    withWorkspaceTasksSession,
  });

  return {
    ...api,
    workspace,
    apiBaseUrl,
    async close() {
      if (closed) return;
      closed = true;
      const pending = Array.from(sessionPromises.values());
      sessionPromises.clear();
      await Promise.allSettled(
        pending.map(async (promise) => {
          const entry = await promise;
          await entry.session.close();
        }),
      );
      client.close();
    },
  };
}
