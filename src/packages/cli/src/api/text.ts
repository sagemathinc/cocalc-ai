import { RefcountLeaseManager } from "@cocalc/util/refcount/lease";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import "@cocalc/conat/sync-doc/install";
import { isAbsolute, resolve as resolvePath } from "node:path";

import {
  defaultApiBaseUrl,
  openCurrentProjectConnection,
  type CurrentProjectIdentity,
} from "./current-project";
import {
  resolveTextDocumentAssociation,
  type TextDocumentAssociation,
} from "./text-associations";

export type TextProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

export type TextDocumentBindingOptions = {
  projectIdentifier?: string;
  path: string;
  cwd?: string;
};

export type TextWriteOptions = {
  expectedLatestVersionId?: string | null;
  expectedHash?: number | null;
  saveToDisk?: boolean;
};

export type TextReplaceOptions = TextWriteOptions & {
  all?: boolean;
};

export type TextDocumentInfo<Project extends TextProjectIdentity> = {
  project: Project;
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
  save_to_disk?: () => Promise<void>;
  historyLastVersion(): string | undefined;
  hash_of_live_version(): number | undefined;
};

function guardTextSession(client: ConatClient, raw: SyncStringLike) {
  let failure: Error | undefined;
  const waiters = new Set<(error: Error) => void>();
  const fail = (message: string) => {
    if (failure) return;
    failure = new Error(message);
    for (const reject of waiters) reject(failure);
    waiters.clear();
  };
  const close = () => {
    fail("live text session interrupted: session closed");
    client.removeListener("info", checkAuthority);
    client.removeListener("closed", clientClosed);
    return raw.close();
  };
  const interrupt = (message: string) => {
    if (failure) return;
    fail(message);
    // Closing discards pending edits; it must not acknowledge a pending save.
    void (async () => {
      await close();
    })().catch(() => undefined);
  };
  const checkAuthority = () => {
    if (client.info?.user?.error) {
      interrupt("live text session interrupted: authorization failed");
    }
  };
  const clientClosed = () => {
    interrupt("live text session interrupted: connection closed");
  };
  const check = () => {
    if (failure) throw failure;
  };
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    check();
    return await new Promise<T>((resolve, reject) => {
      waiters.add(reject);
      // Remove each completed operation instead of retaining handlers on one
      // never-settling promise for the entire editing session.
      const done = () => waiters.delete(reject);
      try {
        Promise.resolve(fn()).then(
          (value) => {
            done();
            resolve(value);
          },
          (error) => {
            done();
            reject(error);
          },
        );
      } catch (error) {
        done();
        reject(error);
      }
    });
  };
  const session: SyncStringLike = {
    wait_until_ready: () => run(() => raw.wait_until_ready()),
    isClosed: () => !!failure || raw.isClosed(),
    close,
    to_str: () => {
      check();
      return raw.to_str();
    },
    from_str: (text) => {
      check();
      raw.from_str(text);
    },
    save: () => run(() => raw.save()),
    ...(raw.save_to_disk
      ? { save_to_disk: () => run(() => raw.save_to_disk!()) }
      : {}),
    historyLastVersion: () => {
      check();
      return raw.historyLastVersion();
    },
    hash_of_live_version: () => {
      check();
      return raw.hash_of_live_version();
    },
  };
  client.on("info", checkAuthority);
  client.on("closed", clientClosed);
  if (client.state === "closed") clientClosed();
  else if (client.state === "connected") checkAuthority();
  return { session, run };
}

type WithProjectTextSession<Ctx, Project extends TextProjectIdentity> = <T>(
  ctx: Ctx,
  options: TextDocumentBindingOptions,
  fn: (args: {
    project: Project;
    session: SyncStringLike;
    path: string;
    association: TextDocumentAssociation;
  }) => Promise<T>,
) => Promise<T>;

export interface BoundTextDocument<Project extends TextProjectIdentity> {
  readonly projectIdentifier?: string;
  readonly path: string;
  readonly cwd?: string;

  getAssociation(): TextDocumentAssociation;
  getInfo(): Promise<TextDocumentInfo<Project>>;
  read(): Promise<TextDocumentInfo<Project> & { text: string }>;
  write(
    text: string,
    options?: TextWriteOptions,
  ): Promise<TextDocumentInfo<Project>>;
  append(
    text: string,
    options?: TextWriteOptions,
  ): Promise<TextDocumentInfo<Project>>;
  replace(
    search: string,
    replacement: string,
    options?: TextReplaceOptions,
  ): Promise<TextDocumentInfo<Project> & { replaceCount: number }>;
  withSession<T>(
    fn: (args: {
      project: Project;
      session: SyncStringLike;
      path: string;
      association: TextDocumentAssociation;
    }) => Promise<T>,
  ): Promise<T>;
}

export interface TextApi<Ctx, Project extends TextProjectIdentity> {
  association(options: TextDocumentBindingOptions): TextDocumentAssociation;
  bindDocument(
    ctx: Ctx,
    options: TextDocumentBindingOptions,
  ): BoundTextDocument<Project>;
}

export interface OpenTextApiOptions {
  apiBaseUrl?: string;
  bearer?: string;
  projectId?: string;
  timeoutMs?: number;
  sessionOpenTimeoutMs?: number;
}

export interface OpenedTextApi extends TextApi<undefined, TextProjectIdentity> {
  readonly project: TextProjectIdentity;
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

function currentTextInfo<Project extends TextProjectIdentity>(
  project: Project,
  path: string,
  session: SyncStringLike,
  association: TextDocumentAssociation,
): TextDocumentInfo<Project> {
  const text = session.to_str();
  return {
    project,
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

async function saveTextSession(
  session: SyncStringLike,
  options?: TextWriteOptions,
): Promise<void> {
  await session.save();
  if (options?.saveToDisk === false) {
    return;
  }
  if (typeof session.save_to_disk !== "function") {
    throw new Error("live text session does not support saving to disk");
  }
  await session.save_to_disk();
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
      text.slice(0, index) + replacement + text.slice(index + search.length),
    replaceCount: 1,
  };
}

export function createTextApi<Ctx, Project extends TextProjectIdentity>({
  withProjectTextSession,
}: {
  withProjectTextSession: WithProjectTextSession<Ctx, Project>;
}): TextApi<Ctx, Project> {
  function association(
    options: TextDocumentBindingOptions,
  ): TextDocumentAssociation {
    return resolveTextDocumentAssociation(normalizeTextPath(options.path));
  }

  function bindDocument(
    ctx: Ctx,
    options: TextDocumentBindingOptions,
  ): BoundTextDocument<Project> {
    const binding = {
      projectIdentifier: options.projectIdentifier,
      path: options.path,
      cwd: options.cwd,
    } as const;
    const resolvedAssociation = association(binding);

    const withSession = async <T>(
      fn: (args: {
        project: Project;
        session: SyncStringLike;
        path: string;
        association: TextDocumentAssociation;
      }) => Promise<T>,
    ): Promise<T> => await withProjectTextSession(ctx, binding, fn);

    return {
      ...binding,
      getAssociation() {
        return resolvedAssociation;
      },
      async getInfo() {
        return await withSession(
          async ({ project, session, path, association }) =>
            currentTextInfo(project, path, session, association),
        );
      },
      async read() {
        return await withSession(
          async ({ project, session, path, association }) => ({
            ...currentTextInfo(project, path, session, association),
            text: session.to_str(),
          }),
        );
      },
      async write(text: string, writeOptions?: TextWriteOptions) {
        return await withSession(
          async ({ project, session, path, association }) => {
            const before = currentTextInfo(project, path, session, association);
            assertTextWriteExpectation(before, writeOptions);
            if (session.to_str() !== text) {
              session.from_str(text);
            }
            // The live text may already match while disk still has older content.
            await saveTextSession(session, writeOptions);
            return currentTextInfo(project, path, session, association);
          },
        );
      },
      async append(text: string, writeOptions?: TextWriteOptions) {
        return await withSession(
          async ({ project, session, path, association }) => {
            const before = currentTextInfo(project, path, session, association);
            assertTextWriteExpectation(before, writeOptions);
            if (text) {
              session.from_str(session.to_str() + text);
              await saveTextSession(session, writeOptions);
            }
            return currentTextInfo(project, path, session, association);
          },
        );
      },
      async replace(
        search: string,
        replacement: string,
        replaceOptions?: TextReplaceOptions,
      ) {
        return await withSession(
          async ({ project, session, path, association }) => {
            const before = currentTextInfo(project, path, session, association);
            assertTextWriteExpectation(before, replaceOptions);
            const next = replaceString(
              session.to_str(),
              search,
              replacement,
              replaceOptions?.all,
            );
            if (next.replaceCount > 0) {
              session.from_str(next.text);
              await saveTextSession(session, replaceOptions);
            }
            return {
              ...currentTextInfo(project, path, session, association),
              replaceCount: next.replaceCount,
            };
          },
        );
      },
      async withSession<T>(
        fn: (args: {
          project: Project;
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
  run: <T>(fn: () => Promise<T>) => Promise<T>;
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
  const raw = client.sync.string({
    project_id: projectId,
    path: normalizedPath,
    ...(persistent != null ? { persistent } : {}),
    ...(fileUseInterval != null
      ? { document_activity_interval: fileUseInterval }
      : {}),
  }) as unknown as SyncStringLike;
  const { session, run } = guardTextSession(client, raw);

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
  } catch (error) {
    try {
      await session.close();
    } catch {
      /* Preserve the opening error. */
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  return {
    session,
    run,
    path: normalizedPath,
    association,
  };
}

export function createLiveTextBinder<Ctx, Project extends TextProjectIdentity>({
  resolveProjectConatClient,
  openTimeoutMs = DEFAULT_SESSION_OPEN_TIMEOUT_MS,
  leaseMs = DEFAULT_SESSION_LEASE_MS,
}: {
  resolveProjectConatClient: (
    ctx: Ctx,
    projectIdentifier?: string,
    cwd?: string,
  ) => Promise<{ project: Project; client: ConatClient }>;
  openTimeoutMs?: number;
  leaseMs?: number;
}): TextApi<Ctx, Project> {
  type Entry = {
    project: Project;
    session: SyncStringLike;
    run: <T>(fn: () => Promise<T>) => Promise<T>;
    path: string;
    association: TextDocumentAssociation;
  };
  const sessionPromises = new Map<string, Promise<Entry>>();
  const clientIds = new WeakMap<ConatClient, number>();
  let nextClientId = 0;
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

  const withProjectTextSession: WithProjectTextSession<Ctx, Project> = async (
    ctx,
    options,
    fn,
  ) => {
    const { project, client } = await resolveProjectConatClient(
      ctx,
      options.projectIdentifier,
      options.cwd,
    );
    const path = normalizeTextPath(options.path);
    // Never share live drafts across credential-bearing client instances.
    if (!clientIds.has(client)) clientIds.set(client, nextClientId++);
    const key = JSON.stringify({
      client: clientIds.get(client),
      project_id: project.project_id,
      path,
    });
    const release = await leases.acquire(key);
    try {
      let entryPromise = sessionPromises.get(key);
      if (entryPromise && (await entryPromise).session.isClosed()) {
        if (sessionPromises.get(key) === entryPromise)
          sessionPromises.delete(key);
        entryPromise = sessionPromises.get(key);
      }
      if (!entryPromise) {
        const created = (async () => {
          const opened = await openLiveTextSession({
            client,
            projectId: project.project_id,
            path,
            persistent: true,
            fileUseInterval: 0,
            openTimeoutMs,
          });
          return { project, ...opened };
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
      return await entry.run(() => fn(entry));
    } finally {
      await release();
    }
  };

  return createTextApi({ withProjectTextSession });
}

export async function openTextApi(
  options: OpenTextApiOptions = {},
): Promise<OpenedTextApi> {
  const {
    apiBaseUrl = defaultApiBaseUrl(),
    projectId,
    client,
    project,
  } = await openCurrentProjectConnection(options);

  const sessionPromises = new Map<
    string,
    Promise<{
      project: CurrentProjectIdentity;
      session: SyncStringLike;
      run: <T>(fn: () => Promise<T>) => Promise<T>;
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

  const withProjectTextSession: WithProjectTextSession<
    undefined,
    CurrentProjectIdentity
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
      if (entryPromise && (await entryPromise).session.isClosed()) {
        if (sessionPromises.get(key) === entryPromise)
          sessionPromises.delete(key);
        entryPromise = sessionPromises.get(key);
      }
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
          return { project, ...opened };
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
      return await entry.run(() => fn(entry));
    } finally {
      await release();
    }
  };

  const api = createTextApi<undefined, CurrentProjectIdentity>({
    withProjectTextSession,
  });

  return {
    ...api,
    project,
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
