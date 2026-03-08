import { RefcountLeaseManager } from "@cocalc/util/refcount/lease";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { isAbsolute, resolve as resolvePath } from "node:path";

import {
  defaultApiBaseUrl,
  openCurrentProjectConnection,
  type CurrentProjectWorkspaceIdentity,
} from "./current-project";
import {
  resolveTextDocumentAssociation,
  type TextDocumentAssociation,
} from "./text-associations";

export type TextWorkspaceIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

export type TextDocumentBindingOptions = {
  workspaceIdentifier?: string;
  path: string;
  cwd?: string;
};

export type TextWriteOptions = {
  expectedLatestVersionId?: string | null;
  expectedHash?: number | null;
};

export type TextReplaceOptions = TextWriteOptions & {
  all?: boolean;
};

export type TextDocumentInfo<Workspace extends TextWorkspaceIdentity> = {
  workspace: Workspace;
  path: string;
  association: TextDocumentAssociation;
  textLength: number;
  latestVersionId: string | null;
  hash: number | null;
};

type SyncStringLike = {
  wait_until_ready(): Promise<void>;
  isClosed(): boolean;
  close(): void | Promise<void>;
  to_str(): string;
  from_str(text: string): void;
  save(): Promise<void>;
  historyLastVersion(): string | undefined;
  hash_of_live_version(): number | undefined;
};

type WithWorkspaceTextSession<Ctx, Workspace extends TextWorkspaceIdentity> = <T>(
  ctx: Ctx,
  options: TextDocumentBindingOptions,
  fn: (args: {
    workspace: Workspace;
    session: SyncStringLike;
    path: string;
    association: TextDocumentAssociation;
  }) => Promise<T>,
) => Promise<T>;

export interface BoundTextDocument<Workspace extends TextWorkspaceIdentity> {
  readonly workspaceIdentifier?: string;
  readonly path: string;
  readonly cwd?: string;

  getAssociation(): TextDocumentAssociation;
  getInfo(): Promise<TextDocumentInfo<Workspace>>;
  read(): Promise<TextDocumentInfo<Workspace> & { text: string }>;
  write(
    text: string,
    options?: TextWriteOptions,
  ): Promise<TextDocumentInfo<Workspace>>;
  append(
    text: string,
    options?: TextWriteOptions,
  ): Promise<TextDocumentInfo<Workspace>>;
  replace(
    search: string,
    replacement: string,
    options?: TextReplaceOptions,
  ): Promise<TextDocumentInfo<Workspace> & { replaceCount: number }>;
  withSession<T>(
    fn: (args: {
      workspace: Workspace;
      session: SyncStringLike;
      path: string;
      association: TextDocumentAssociation;
    }) => Promise<T>,
  ): Promise<T>;
}

export interface TextApi<Ctx, Workspace extends TextWorkspaceIdentity> {
  association(options: TextDocumentBindingOptions): TextDocumentAssociation;
  bindDocument(
    ctx: Ctx,
    options: TextDocumentBindingOptions,
  ): BoundTextDocument<Workspace>;
}

export interface OpenTextApiOptions {
  apiBaseUrl?: string;
  bearer?: string;
  projectId?: string;
  timeoutMs?: number;
  sessionOpenTimeoutMs?: number;
}

export interface OpenedTextApi extends TextApi<undefined, TextWorkspaceIdentity> {
  readonly workspace: TextWorkspaceIdentity;
  readonly apiBaseUrl: string;
  close(): Promise<void>;
}

const DEFAULT_SESSION_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_SESSION_LEASE_MS = 30_000;

function normalizeTextPath(path: string): string {
  const trimmed = `${path ?? ""}`.trim();
  if (!trimmed) {
    throw new Error("document path is required");
  }
  if (isAbsolute(trimmed)) {
    return resolvePath(trimmed);
  }
  return resolvePath(process.env.HOME?.trim() || process.cwd(), trimmed);
}

function currentTextInfo<Workspace extends TextWorkspaceIdentity>(
  workspace: Workspace,
  path: string,
  session: SyncStringLike,
  association: TextDocumentAssociation,
): TextDocumentInfo<Workspace> {
  const text = session.to_str();
  return {
    workspace,
    path,
    association,
    textLength: text.length,
    latestVersionId: session.historyLastVersion() ?? null,
    hash: session.hash_of_live_version() ?? null,
  };
}

function assertTextWriteExpectation(
  info: TextDocumentInfo<any>,
  options?: TextWriteOptions,
): void {
  if (options?.expectedLatestVersionId !== undefined) {
    if (options.expectedLatestVersionId !== info.latestVersionId) {
      throw new Error(
        `text document changed since read: expected latestVersionId=${options.expectedLatestVersionId ?? "null"}, got ${info.latestVersionId ?? "null"}`,
      );
    }
  }
  if (options?.expectedHash !== undefined) {
    if (options.expectedHash !== info.hash) {
      throw new Error(
        `text document changed since read: expected hash=${options.expectedHash ?? "null"}, got ${info.hash ?? "null"}`,
      );
    }
  }
}

function replaceString(
  text: string,
  search: string,
  replacement: string,
  all?: boolean,
): { text: string; replaceCount: number } {
  if (!search) {
    throw new Error("replace search string must be non-empty");
  }
  if (all) {
    const parts = text.split(search);
    const replaceCount = parts.length - 1;
    if (replaceCount <= 0) {
      return { text, replaceCount: 0 };
    }
    return {
      text: parts.join(replacement),
      replaceCount,
    };
  }
  const index = text.indexOf(search);
  if (index === -1) {
    return { text, replaceCount: 0 };
  }
  return {
    text:
      text.slice(0, index) +
      replacement +
      text.slice(index + search.length),
    replaceCount: 1,
  };
}

export function createTextApi<Ctx, Workspace extends TextWorkspaceIdentity>({
  withWorkspaceTextSession,
}: {
  withWorkspaceTextSession: WithWorkspaceTextSession<Ctx, Workspace>;
}): TextApi<Ctx, Workspace> {
  function association(options: TextDocumentBindingOptions): TextDocumentAssociation {
    return resolveTextDocumentAssociation(normalizeTextPath(options.path));
  }

  function bindDocument(
    ctx: Ctx,
    options: TextDocumentBindingOptions,
  ): BoundTextDocument<Workspace> {
    const binding = {
      workspaceIdentifier: options.workspaceIdentifier,
      path: options.path,
      cwd: options.cwd,
    } as const;
    const resolvedAssociation = association(binding);

    const withSession = async <T>(
      fn: (args: {
        workspace: Workspace;
        session: SyncStringLike;
        path: string;
        association: TextDocumentAssociation;
      }) => Promise<T>,
    ): Promise<T> =>
      await withWorkspaceTextSession(ctx, binding, fn);

    return {
      ...binding,
      getAssociation() {
        return resolvedAssociation;
      },
      async getInfo() {
        return await withSession(async ({ workspace, session, path, association }) =>
          currentTextInfo(workspace, path, session, association),
        );
      },
      async read() {
        return await withSession(async ({ workspace, session, path, association }) => ({
          ...currentTextInfo(workspace, path, session, association),
          text: session.to_str(),
        }));
      },
      async write(text: string, writeOptions?: TextWriteOptions) {
        return await withSession(async ({ workspace, session, path, association }) => {
          const before = currentTextInfo(workspace, path, session, association);
          assertTextWriteExpectation(before, writeOptions);
          if (session.to_str() !== text) {
            session.from_str(text);
            await session.save();
          }
          return currentTextInfo(workspace, path, session, association);
        });
      },
      async append(text: string, writeOptions?: TextWriteOptions) {
        return await withSession(async ({ workspace, session, path, association }) => {
          const before = currentTextInfo(workspace, path, session, association);
          assertTextWriteExpectation(before, writeOptions);
          if (text) {
            session.from_str(session.to_str() + text);
            await session.save();
          }
          return currentTextInfo(workspace, path, session, association);
        });
      },
      async replace(
        search: string,
        replacement: string,
        replaceOptions?: TextReplaceOptions,
      ) {
        return await withSession(async ({ workspace, session, path, association }) => {
          const before = currentTextInfo(workspace, path, session, association);
          assertTextWriteExpectation(before, replaceOptions);
          const next = replaceString(
            session.to_str(),
            search,
            replacement,
            replaceOptions?.all,
          );
          if (next.replaceCount > 0) {
            session.from_str(next.text);
            await session.save();
          }
          return {
            ...currentTextInfo(workspace, path, session, association),
            replaceCount: next.replaceCount,
          };
        });
      },
      async withSession<T>(
        fn: (args: {
          workspace: Workspace;
          session: SyncStringLike;
          path: string;
          association: TextDocumentAssociation;
        }) => Promise<T>,
      ) {
        return await withSession(fn);
      },
    };
  }

  return { association, bindDocument };
}

export async function openLiveTextSession({
  client,
  projectId,
  path,
  persistent,
  fileUseInterval,
  openTimeoutMs = DEFAULT_SESSION_OPEN_TIMEOUT_MS,
}: {
  client: ConatClient;
  projectId: string;
  path: string;
  persistent?: boolean;
  fileUseInterval?: number;
  openTimeoutMs?: number;
}): Promise<{
  session: SyncStringLike;
  path: string;
  association: TextDocumentAssociation;
}> {
  const normalizedPath = normalizeTextPath(path);
  const association = resolveTextDocumentAssociation(normalizedPath);
  if (!association.supportsTextApi) {
    throw new Error(
      `path '${normalizedPath}' is a structured document (${association.doctype}), not a text document`,
    );
  }
  const session = client.sync.string({
    project_id: projectId,
    path: normalizedPath,
    ...(persistent != null ? { persistent } : {}),
    ...(fileUseInterval != null ? { file_use_interval: fileUseInterval } : {}),
  }) as unknown as SyncStringLike;

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      session.wait_until_ready(),
      new Promise<never>((_, reject) => {
        if (openTimeoutMs <= 0) return;
        timer = setTimeout(() => {
          reject(
            new Error(
              `timeout waiting for live text session to become ready (${openTimeoutMs}ms)`,
            ),
          );
        }, openTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  return {
    session,
    path: normalizedPath,
    association,
  };
}

export function createLiveTextBinder<Ctx, Workspace extends TextWorkspaceIdentity>({
  resolveWorkspaceConatClient,
  openTimeoutMs = DEFAULT_SESSION_OPEN_TIMEOUT_MS,
  leaseMs = DEFAULT_SESSION_LEASE_MS,
}: {
  resolveWorkspaceConatClient: (
    ctx: Ctx,
    workspaceIdentifier?: string,
    cwd?: string,
  ) => Promise<{ workspace: Workspace; client: ConatClient }>;
  openTimeoutMs?: number;
  leaseMs?: number;
}): TextApi<Ctx, Workspace> {
  type Entry = {
    workspace: Workspace;
    session: SyncStringLike;
    path: string;
    association: TextDocumentAssociation;
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

  const withWorkspaceTextSession: WithWorkspaceTextSession<Ctx, Workspace> =
    async (ctx, options, fn) => {
      const { workspace, client } = await resolveWorkspaceConatClient(
        ctx,
        options.workspaceIdentifier,
        options.cwd,
      );
      const path = normalizeTextPath(options.path);
      const key = JSON.stringify({ project_id: workspace.project_id, path });
      const release = await leases.acquire(key);
      try {
        let entryPromise = sessionPromises.get(key);
        if (!entryPromise) {
          const created = (async () => {
            const opened = await openLiveTextSession({
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

  return createTextApi({ withWorkspaceTextSession });
}

export async function openTextApi(
  options: OpenTextApiOptions = {},
): Promise<OpenedTextApi> {
  const {
    apiBaseUrl = defaultApiBaseUrl(),
    projectId,
    client,
    workspace,
  } = await openCurrentProjectConnection(options);

  const sessionPromises = new Map<
    string,
    Promise<{
      workspace: CurrentProjectWorkspaceIdentity;
      session: SyncStringLike;
      path: string;
      association: TextDocumentAssociation;
    }>
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

  const withWorkspaceTextSession: WithWorkspaceTextSession<
    undefined,
    CurrentProjectWorkspaceIdentity
  > = async (ctx, docOptions, fn) => {
    void ctx;
    if (closed) {
      throw new Error("text api is closed");
    }
    const path = normalizeTextPath(docOptions.path);
    const key = JSON.stringify({ project_id: projectId, path });
    const release = await sessionLeases.acquire(key);
    try {
      let entryPromise = sessionPromises.get(key);
      if (!entryPromise) {
        const created = (async () => {
          const opened = await openLiveTextSession({
            client,
            projectId,
            path,
            persistent: true,
            fileUseInterval: 0,
            openTimeoutMs:
              options.sessionOpenTimeoutMs ?? DEFAULT_SESSION_OPEN_TIMEOUT_MS,
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

  const api = createTextApi<undefined, CurrentProjectWorkspaceIdentity>({
    withWorkspaceTextSession,
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
