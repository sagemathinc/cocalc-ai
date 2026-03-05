import { client_db } from "@cocalc/util/db-schema/client-db";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import { requireAbsolutePath } from "./common-utils";

type BrowserSyncDocType = "string" | "db" | "immer";

export function createManagedSyncDocLeases({
  conat,
}: {
  conat: () => ConatClient;
}): {
  acquireManagedSyncDoc: ({
    project_id,
    path,
    isCanceled,
  }: {
    project_id: string;
    path: string;
    isCanceled?: () => boolean;
  }) => Promise<{ syncdoc: any; release: () => Promise<void> }>;
  closeAllManagedSyncDocs: () => Promise<void>;
} {
  const managedSyncDocs = new Map<
    string,
    {
      refcount: number;
      syncdoc?: any;
      opening?: Promise<any>;
    }
  >();

  const closeManagedSyncDoc = async (key: string): Promise<void> => {
    const entry = managedSyncDocs.get(key);
    if (!entry) return;
    if (entry.opening != null) {
      try {
        await entry.opening;
      } catch {
        // ignore open errors on close path
      }
    }
    managedSyncDocs.delete(key);
    try {
      await entry.syncdoc?.close?.();
    } catch {
      // ignore close errors
    }
  };

  const closeAllManagedSyncDocs = async (): Promise<void> => {
    const keys = [...managedSyncDocs.keys()];
    for (const key of keys) {
      await closeManagedSyncDoc(key);
    }
  };

  const parseDocTypeFromSyncstring = (raw: unknown): {
    type: BrowserSyncDocType;
    opts?: Record<string, unknown>;
  } => {
    if (typeof raw !== "string" || raw.trim() === "") {
      return { type: "string" };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { type: "string" };
    }
    const typeRaw = `${parsed?.type ?? "string"}`.toLowerCase();
    const type: BrowserSyncDocType =
      typeRaw === "db" ? "db" : typeRaw.includes("immer") ? "immer" : "string";
    const opts =
      parsed?.opts != null && typeof parsed.opts === "object"
        ? (parsed.opts as Record<string, unknown>)
        : undefined;
    return { type, opts };
  };

  const toStringArray = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.map((x) => `${x ?? ""}`).filter((x) => x.length > 0);
    }
    if (value instanceof Set) {
      return [...value].map((x) => `${x ?? ""}`).filter((x) => x.length > 0);
    }
    return [];
  };

  const getSyncDocTypeForPath = async ({
    project_id,
    path,
  }: {
    project_id: string;
    path: string;
  }): Promise<{ type: BrowserSyncDocType; opts?: Record<string, unknown> }> => {
    const string_id = client_db.sha1(project_id, path);
    const syncstrings = await conat().sync.synctable({
      query: {
        syncstrings: [{ project_id, path, string_id, doctype: null }],
      },
      stream: false,
      atomic: false,
      immutable: false,
      noInventory: true,
    });
    try {
      const getOne = (syncstrings as any).get_one ?? (syncstrings as any).getOne;
      const row = typeof getOne === "function" ? getOne.call(syncstrings) : undefined;
      return parseDocTypeFromSyncstring(row?.doctype);
    } finally {
      try {
        syncstrings?.close?.();
      } catch {
        // ignore close errors
      }
    }
  };

  const openSyncDocDirectly = async ({
    project_id,
    path,
  }: {
    project_id: string;
    path: string;
  }): Promise<any> => {
    const cleanPath = requireAbsolutePath(path);
    const { type, opts } = await getSyncDocTypeForPath({
      project_id,
      path: cleanPath,
    });
    const commonOpts = {
      project_id,
      path: cleanPath,
      noSaveToDisk: true,
      noAutosave: true,
      firstReadLockTimeout: 1,
    };
    const primary_keys = toStringArray(
      (opts as any)?.primary_keys ?? (opts as any)?.primaryKeys,
    );
    const string_cols = toStringArray(
      (opts as any)?.string_cols ?? (opts as any)?.stringCols,
    );
    const sync = conat().sync;
    const syncdoc =
      type === "immer" && primary_keys.length > 0
        ? sync.immer({ ...commonOpts, primary_keys, string_cols })
        : type === "db" && primary_keys.length > 0
          ? sync.db({ ...commonOpts, primary_keys, string_cols })
          : sync.string(commonOpts);
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      const state =
        typeof syncdoc?.get_state === "function" ? syncdoc.get_state() : "ready";
      if (state === "ready") {
        return syncdoc;
      }
      if (state === "closed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      await syncdoc?.close?.();
    } catch {
      // ignore close errors
    }
    throw Error(`syncdoc not ready for ${cleanPath}`);
  };

  const acquireManagedSyncDoc = async ({
    project_id,
    path,
    isCanceled,
  }: {
    project_id: string;
    path: string;
    isCanceled?: () => boolean;
  }): Promise<{ syncdoc: any; release: () => Promise<void> }> => {
    const cleanPath = requireAbsolutePath(path);
    const key = `${project_id}:${cleanPath}`;
    let entry = managedSyncDocs.get(key);
    if (!entry) {
      entry = { refcount: 0 };
      managedSyncDocs.set(key, entry);
    }
    entry.refcount += 1;

    if (!entry.syncdoc) {
      if (!entry.opening) {
        entry.opening = (async () => {
          const doc = await openSyncDocDirectly({
            project_id,
            path: cleanPath,
          });
          entry!.syncdoc = doc;
          return doc;
        })().finally(() => {
          if (entry != null) {
            delete entry.opening;
          }
        });
      }
      try {
        await entry.opening;
      } catch (err) {
        entry.refcount = Math.max(0, entry.refcount - 1);
        if (entry.refcount <= 0) {
          managedSyncDocs.delete(key);
        }
        throw err;
      }
    }

    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      const current = managedSyncDocs.get(key);
      if (!current) return;
      current.refcount = Math.max(0, current.refcount - 1);
      if (current.refcount <= 0 && !current.opening) {
        await closeManagedSyncDoc(key);
      }
    };

    if (isCanceled?.()) {
      await release();
      throw Error("execution canceled");
    }
    return { syncdoc: entry.syncdoc, release };
  };

  return { acquireManagedSyncDoc, closeAllManagedSyncDocs };
}
