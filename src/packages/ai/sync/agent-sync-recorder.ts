import { promises as fs } from "node:fs";
import path from "node:path";

import { getLogger, type Logger } from "@cocalc/conat/client";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { akv } from "@cocalc/conat/sync/akv";
import {
  getSyncDocDescriptor,
  type SyncDocDescriptor,
} from "@cocalc/sync/editor/doctypes";
import type { JSONValue } from "@cocalc/util/types";

type PatchId = string;

export type AgentSyncDoc = {
  isReady: () => boolean;
  to_str: () => string;
  commit: (options?: { meta?: { [key: string]: JSONValue } }) => boolean;
  versions: () => PatchId[];
  newestVersion?: () => PatchId | undefined;
  hasVersion?: (patchId: PatchId) => boolean;
  version: (patchId: PatchId) => { to_str?: () => string };
  close: () => Promise<void>;
  on: (event: "change", handler: (arg?: unknown) => void) => void;
  off: (event: "change", handler: (arg?: unknown) => void) => void;
  once: (
    event: "ready" | "error" | "change",
    handler: (arg?: unknown) => void,
  ) => void;
};

type ReadState = {
  patchId: PatchId;
  atMs: number;
  lastReadTurnId?: string;
};

type ReadStateStore = {
  get: (key: string) => Promise<ReadState | undefined>;
  set: (key: string, value: ReadState) => Promise<void>;
  delete?: (key: string) => Promise<void>;
  close?: () => void;
};

type SyncDocEntry = {
  doc: AgentSyncDoc;
  lastUsedMs: number;
};

type AgentTimeTravelRecorderOptions = {
  project_id: string;
  chat_path: string;
  chat_thread_id: string;
  chat_message_id: string;
  log_store: string;
  log_key: string;
  log_subject: string;
  client: ConatClient;
  workspaceRoot: string;
  sessionId?: string;
  threadId?: string;
  writeCommitWaitMs?: number;
  readStateStore?: ReadStateStore;
  syncFactory?: (relativePath: string) => Promise<AgentSyncDoc | undefined>;
  now?: () => number;
};

const DEFAULT_SYNC_DOC_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SYNC_DOC_CACHE_MAX = 32;
const DEFAULT_WRITE_COMMIT_WAIT_MS = 5000;
const MAX_FILE_SIZE_B = 4_000_000;

export class AgentTimeTravelRecorder {
  // Record best-effort agent edits into patchflow without caching file contents.
  private readonly projectId: string;
  private readonly chatPath: string;
  private readonly chatThreadId: string;
  private readonly chatMessageId: string;
  private readonly logStore: string;
  private readonly logKey: string;
  private readonly logSubject: string;
  private readonly client: ConatClient;
  private readonly workspaceRoot: string;
  private readonly homeRoot: string | undefined;
  private readonly logger: Logger;
  private readonly store: ReadStateStore;
  private readonly syncDocCacheTtlMs: number;
  private readonly syncDocCacheMax: number;
  private readonly writeCommitWaitMs: number;
  private readonly syncDocs = new Map<string, SyncDocEntry>();
  private readonly turnPaths = new Map<string, Set<string>>();
  private readonly syncDocLoads = new Map<
    string,
    Promise<AgentSyncDoc | undefined>
  >();
  private readonly docTypeCache = new Map<
    string,
    { entry: SyncDocDescriptor; atMs: number }
  >();
  private readonly readCache = new Map<string, ReadState>();
  private readonly syncFactory?: (
    relativePath: string,
  ) => Promise<AgentSyncDoc | undefined>;
  private readonly now: () => number;
  private pruneTimer?: NodeJS.Timeout;
  private sessionId?: string;
  private threadId?: string;
  private disposed = false;
  private readonly pendingOps = new Set<Promise<void>>();
  private finalizedTurns = 0;
  private finalizedTurnSyncDocsClosed = 0;

  constructor(options: AgentTimeTravelRecorderOptions) {
    this.projectId = options.project_id;
    this.chatPath = options.chat_path;
    this.chatThreadId = options.chat_thread_id;
    this.chatMessageId = options.chat_message_id;
    this.logStore = options.log_store;
    this.logKey = options.log_key;
    this.logSubject = options.log_subject;
    this.client = options.client;
    this.workspaceRoot = path.normalize(options.workspaceRoot ?? "");
    this.homeRoot = process.env.HOME;
    this.logger = getLogger("chat:agent-time-travel");
    this.sessionId = options.sessionId;
    this.threadId = options.threadId;
    this.writeCommitWaitMs =
      options.writeCommitWaitMs ?? DEFAULT_WRITE_COMMIT_WAIT_MS;
    this.syncFactory = options.syncFactory;
    this.now = options.now ?? (() => Date.now());
    this.store =
      options.readStateStore ??
      this.buildDefaultStore({
        project_id: this.projectId,
        name: this.logStore,
        client: this.client,
      });
    this.syncDocCacheTtlMs = DEFAULT_SYNC_DOC_TTL_MS;
    this.syncDocCacheMax = DEFAULT_SYNC_DOC_CACHE_MAX;
    this.startPruneTimer();
  }

  setThreadId(threadId: string): void {
    this.threadId = threadId;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  recordRead(filePath: string, turnId?: string): Promise<void> {
    return this.trackOperation("read", filePath, () =>
      this.recordReadImpl(filePath, turnId),
    );
  }

  private async recordReadImpl(
    filePath: string,
    turnId?: string,
  ): Promise<void> {
    if (this.disposed) return;
    const resolved = this.resolvePath(filePath);
    if (!resolved) return;
    const { relativePath, absolutePath } = resolved;
    if (this.disposed) return;
    if (await this.isFileTooLarge(absolutePath, relativePath)) {
      return;
    }
    if (this.disposed) return;
    const syncdoc = await this.getSyncDoc(relativePath);
    if (!syncdoc) {
      this.logger.debug("agent-tt skip read (no syncdoc)", { relativePath });
      return;
    }
    this.trackTurnPath(relativePath, turnId ?? this.chatMessageId);
    let patchId = this.getLatestPatchId(syncdoc);
    if (!patchId) {
      patchId = await this.waitForCommit(syncdoc, patchId);
      if (!patchId) {
        this.logger.debug("agent-tt skip read (no patch id)", {
          relativePath,
          waitMs: this.writeCommitWaitMs,
        });
        return;
      }
    }
    const readState: ReadState = {
      patchId,
      atMs: this.now(),
      lastReadTurnId: turnId ?? this.chatMessageId,
    };
    const key = this.readKey(relativePath);
    this.readCache.set(key, readState);
    await this.store.set(key, readState);
    this.logger.debug("agent-tt read cached", { relativePath, patchId });
  }

  recordWrite(filePath: string, turnId?: string): Promise<void> {
    return this.trackOperation("write", filePath, () =>
      this.recordWriteImpl(filePath, turnId),
    );
  }

  private async recordWriteImpl(
    filePath: string,
    turnId?: string,
  ): Promise<void> {
    if (this.disposed) return;
    const resolved = this.resolvePath(filePath);
    if (!resolved) return;
    const { relativePath, absolutePath } = resolved;
    if (this.disposed) return;
    if (await this.isFileTooLarge(absolutePath, relativePath)) {
      return;
    }
    if (this.disposed) return;
    const syncdoc = await this.getSyncDoc(relativePath);
    if (!syncdoc) {
      this.logger.debug("agent-tt skip write (no syncdoc)", { relativePath });
      return;
    }
    this.trackTurnPath(relativePath, turnId ?? this.chatMessageId);

    const startPatchId = this.getLatestPatchId(syncdoc);
    const patchId = await this.waitForCommit(syncdoc, startPatchId);
    if (!patchId) {
      this.logger.debug("agent-tt skip write (no commit observed)", {
        relativePath,
        waitMs: this.writeCommitWaitMs,
      });
      return;
    }
    const meta = this.buildMeta({
      relativePath,
      turnId: turnId ?? this.chatMessageId,
    });
    this.logger.debug("agent-tt commit metadata pending", {
      relativePath,
      patchId,
      meta,
    });
  }

  async finalizeTurn(turnId?: string): Promise<void> {
    if (this.disposed) return;
    const pending = [...this.pendingOps];
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    const paths =
      turnId == null
        ? [...this.syncDocs.keys()]
        : [...(this.turnPaths.get(turnId) ?? [])];
    if (turnId != null) {
      this.turnPaths.delete(turnId);
    } else {
      this.turnPaths.clear();
    }
    let closed = 0;
    for (const relativePath of paths) {
      if (turnId != null && this.isTrackedByOtherTurn(relativePath, turnId)) {
        continue;
      }
      const entry = this.syncDocs.get(relativePath);
      if (!entry) continue;
      this.syncDocs.delete(relativePath);
      await this.closeSyncDoc(relativePath, entry.doc);
      closed += 1;
    }
    this.finalizedTurns += 1;
    this.finalizedTurnSyncDocsClosed += closed;
    if (closed > 0) {
      this.logger.debug("agent-tt finalize closed syncdocs", {
        turnId: turnId ?? this.chatMessageId,
        closed,
        remainingSyncDocs: this.syncDocs.size,
      });
    }
    this.pruneSyncDocs();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const started = this.now();
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    const pending = [...this.pendingOps];
    if (
      pending.length > 0 ||
      this.syncDocs.size > 0 ||
      this.syncDocLoads.size > 0
    ) {
      this.logger.debug("agent-tt dispose begin", {
        pendingOps: pending.length,
        syncDocs: this.syncDocs.size,
        inflightLoads: this.syncDocLoads.size,
      });
    }
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    for (const [relativePath, entry] of this.syncDocs.entries()) {
      await this.closeSyncDoc(relativePath, entry.doc);
    }
    this.syncDocs.clear();
    this.syncDocLoads.clear();
    this.pendingOps.clear();
    this.readCache.clear();
    this.docTypeCache.clear();
    this.turnPaths.clear();
    this.store.close?.();
    this.logger.debug("agent-tt dispose complete", {
      durationMs: this.now() - started,
    });
  }

  debugStats(): {
    disposed: boolean;
    syncDocs: number;
    inflightLoads: number;
    pendingOps: number;
    readCache: number;
    oldestDocAgeMs: number;
    trackedTurns: number;
    trackedTurnPaths: number;
    finalizedTurns: number;
    finalizedTurnSyncDocsClosed: number;
  } {
    const nowMs = this.now();
    let oldestDocAgeMs = 0;
    for (const entry of this.syncDocs.values()) {
      const age = Math.max(0, nowMs - entry.lastUsedMs);
      if (age > oldestDocAgeMs) {
        oldestDocAgeMs = age;
      }
    }
    return {
      disposed: this.disposed,
      syncDocs: this.syncDocs.size,
      inflightLoads: this.syncDocLoads.size,
      pendingOps: this.pendingOps.size,
      readCache: this.readCache.size,
      oldestDocAgeMs,
      trackedTurns: this.turnPaths.size,
      trackedTurnPaths: [...this.turnPaths.values()].reduce(
        (sum, paths) => sum + paths.size,
        0,
      ),
      finalizedTurns: this.finalizedTurns,
      finalizedTurnSyncDocsClosed: this.finalizedTurnSyncDocsClosed,
    };
  }

  private trackOperation(
    operation: "read" | "write",
    filePath: string,
    f: () => Promise<void>,
  ): Promise<void> {
    if (this.disposed) {
      this.logger.debug("agent-tt skip operation after dispose", {
        operation,
        filePath,
        pendingOps: this.pendingOps.size,
        syncDocs: this.syncDocs.size,
      });
      return Promise.resolve();
    }
    const op = (async () => {
      try {
        await f();
      } catch (err) {
        this.logger.debug("agent-tt operation failed", {
          operation,
          filePath,
          err,
        });
      }
    })();
    this.pendingOps.add(op);
    return op.finally(() => {
      this.pendingOps.delete(op);
    });
  }

  private buildDefaultStore(opts: {
    project_id: string;
    name: string;
    client: ConatClient;
  }): ReadStateStore {
    const store = akv<ReadState>({
      project_id: opts.project_id,
      name: opts.name,
      client: opts.client,
    });
    return {
      get: (key) => store.get(key),
      set: async (key, value) => {
        await store.set(key, value);
      },
      delete: (key) => store.delete(key),
      close: () => store.close(),
    };
  }

  private resolvePath(
    filePath: string,
  ): { absolutePath: string; relativePath: string } | undefined {
    if (!filePath || !this.workspaceRoot) return;
    if (this.looksLikeGlobPath(filePath)) {
      this.logger.debug("agent-tt skip glob-like path", { filePath });
      return;
    }
    const candidates: string[] = [];
    if (path.isAbsolute(filePath)) {
      candidates.push(path.normalize(filePath));
    } else {
      if (this.homeRoot) {
        candidates.push(path.resolve(this.homeRoot, filePath));
      }
      candidates.push(path.resolve(this.workspaceRoot, filePath));
    }

    for (const candidate of candidates) {
      if (!this.isUnderRoot(candidate, this.workspaceRoot)) continue;
      if (this.homeRoot && !this.isUnderRoot(candidate, this.homeRoot)) {
        continue;
      }
      // relativePath is HOME-relative (project root) for syncdoc usage.
      const baseRoot = this.homeRoot ?? this.workspaceRoot;
      const relativePath = path.relative(baseRoot, candidate);
      if (!relativePath || relativePath.startsWith("..")) continue;
      return { absolutePath: candidate, relativePath };
    }

    this.logger.debug("agent-tt skip path outside roots", {
      filePath,
      workspaceRoot: this.workspaceRoot,
      homeRoot: this.homeRoot,
    });
    return;
  }

  private looksLikeGlobPath(filePath: string): boolean {
    return filePath.includes("*") || filePath.includes("?");
  }

  private isUnderRoot(candidate: string, root: string): boolean {
    const normalizedRoot = path.normalize(root);
    const normalizedCandidate = path.normalize(candidate);
    return (
      normalizedCandidate === normalizedRoot ||
      normalizedCandidate.startsWith(normalizedRoot + path.sep)
    );
  }

  private readKey(relativePath: string): string {
    return `agent-tt:${this.chatThreadId}:file:${relativePath}`;
  }

  private trackTurnPath(relativePath: string, turnId?: string): void {
    if (!turnId) return;
    const paths = this.turnPaths.get(turnId) ?? new Set<string>();
    paths.add(relativePath);
    this.turnPaths.set(turnId, paths);
  }

  private isTrackedByOtherTurn(
    relativePath: string,
    excludingTurnId: string,
  ): boolean {
    for (const [turnId, paths] of this.turnPaths.entries()) {
      if (turnId === excludingTurnId) continue;
      if (paths.has(relativePath)) return true;
    }
    return false;
  }

  private getLatestPatchId(syncdoc: AgentSyncDoc): PatchId | undefined {
    try {
      if (typeof syncdoc.newestVersion === "function") {
        return syncdoc.newestVersion();
      }
      if (typeof syncdoc.versions === "function") {
        const versions = syncdoc.versions();
        return versions[versions.length - 1];
      }
    } catch (err) {
      this.logger.debug("agent-tt latest patch lookup failed", err);
    }
    return undefined;
  }

  private buildMeta({
    relativePath,
    turnId,
  }: {
    relativePath: string;
    turnId: string;
  }): { [key: string]: JSONValue } {
    const meta: { [key: string]: JSONValue } = {
      source: "agent",
      chat_thread_id: this.chatThreadId,
      chat_message_id: turnId,
      chat_path: this.chatPath,
      log_store: this.logStore,
      log_key: this.logKey,
      log_subject: this.logSubject,
      file_path: relativePath,
    };
    if (this.sessionId) {
      meta.agent_session_id = this.sessionId;
    }
    if (this.threadId) {
      meta.agent_thread_id = this.threadId;
    }
    return meta;
  }

  private startPruneTimer(): void {
    this.pruneTimer = setInterval(() => this.pruneSyncDocs(), 60_000);
    this.pruneTimer.unref?.();
  }

  private pruneSyncDocs(): void {
    if (this.disposed) return;
    const nowMs = this.now();
    for (const [relativePath, entry] of this.syncDocs.entries()) {
      if (nowMs - entry.lastUsedMs <= this.syncDocCacheTtlMs) continue;
      void this.closeSyncDoc(relativePath, entry.doc);
      this.syncDocs.delete(relativePath);
    }
    if (this.syncDocs.size <= this.syncDocCacheMax) return;
    const sorted = [...this.syncDocs.entries()].sort(
      (left, right) => left[1].lastUsedMs - right[1].lastUsedMs,
    );
    for (const [relativePath, entry] of sorted) {
      if (this.syncDocs.size <= this.syncDocCacheMax) break;
      void this.closeSyncDoc(relativePath, entry.doc);
      this.syncDocs.delete(relativePath);
    }
  }

  private async getSyncDoc(
    relativePath: string,
  ): Promise<AgentSyncDoc | undefined> {
    if (this.disposed) return;
    const cached = this.syncDocs.get(relativePath);
    const nowMs = this.now();
    if (cached && nowMs - cached.lastUsedMs <= this.syncDocCacheTtlMs) {
      cached.lastUsedMs = nowMs;
      return cached.doc;
    }

    const inflight = this.syncDocLoads.get(relativePath);
    if (inflight) {
      return await inflight;
    }

    const loadPromise = this.loadSyncDoc(relativePath).finally(() => {
      this.syncDocLoads.delete(relativePath);
    });
    this.syncDocLoads.set(relativePath, loadPromise);
    return await loadPromise;
  }

  private async loadSyncDoc(
    relativePath: string,
  ): Promise<AgentSyncDoc | undefined> {
    if (this.disposed) return;
    if (this.syncFactory) {
      try {
        const syncdoc = await this.syncFactory(relativePath);
        if (!syncdoc) return undefined;
        const readyDoc = syncdoc;
        if (!readyDoc.isReady()) {
          await new Promise<void>((resolve, reject) => {
            readyDoc.once("ready", () => resolve());
            readyDoc.once("error", (err) => reject(err));
          });
        }
        if (this.disposed) {
          await this.closeSyncDoc(relativePath, readyDoc);
          return undefined;
        }
        this.syncDocs.set(relativePath, {
          doc: readyDoc,
          lastUsedMs: this.now(),
        });
        this.pruneSyncDocs();
        return readyDoc;
      } catch (err) {
        this.logger.debug("agent-tt syncdoc factory failed", {
          relativePath,
          err,
        });
        return undefined;
      }
    }
    const descriptor = this.resolveDocType(relativePath);
    let syncdoc: AgentSyncDoc | undefined;
    try {
      const options = {
        project_id: this.projectId,
        path: relativePath,
        firstReadLockTimeout: 1,
      };
      if (descriptor.doctype === "syncdb" || descriptor.doctype === "immer") {
        const primaryKeys = descriptor.primary_keys ?? [];
        const stringCols = descriptor.string_cols ?? [];
        if (primaryKeys.length === 0) {
          this.logger.debug("agent-tt fallback to string doc", {
            relativePath,
          });
          syncdoc = this.client.sync.string(options);
        } else {
          syncdoc =
            descriptor.doctype === "immer"
              ? this.client.sync.immer({
                  ...options,
                  primary_keys: primaryKeys,
                  string_cols: stringCols,
                })
              : this.client.sync.db({
                  ...options,
                  primary_keys: primaryKeys,
                  string_cols: stringCols,
                });
        }
      } else {
        syncdoc = this.client.sync.string(options);
      }
      if (!syncdoc) {
        throw new Error("syncdoc initialization failed");
      }
      const readyDoc = syncdoc;
      if (!readyDoc.isReady()) {
        await new Promise<void>((resolve, reject) => {
          readyDoc.once("ready", () => resolve());
          readyDoc.once("error", (err) => reject(err));
        });
      }
      if (this.disposed) {
        await this.closeSyncDoc(relativePath, readyDoc);
        return undefined;
      }
    } catch (err) {
      this.logger.debug("agent-tt syncdoc init failed", {
        relativePath,
        err,
      });
      if (syncdoc) {
        await this.closeSyncDoc(relativePath, syncdoc);
      }
      return undefined;
    }

    this.syncDocs.set(relativePath, { doc: syncdoc, lastUsedMs: this.now() });
    this.pruneSyncDocs();
    return syncdoc;
  }

  private async closeSyncDoc(
    relativePath: string,
    syncdoc: AgentSyncDoc,
  ): Promise<void> {
    try {
      await syncdoc.close();
    } catch (err) {
      this.logger.debug("agent-tt syncdoc close failed", {
        relativePath,
        err,
      });
    }
  }

  private resolveDocType(relativePath: string): SyncDocDescriptor {
    const cached = this.docTypeCache.get(relativePath);
    if (cached && this.now() - cached.atMs < this.syncDocCacheTtlMs) {
      return cached.entry;
    }
    const entry = getSyncDocDescriptor(relativePath);
    this.docTypeCache.set(relativePath, { entry, atMs: this.now() });
    return entry;
  }

  private async isFileTooLarge(
    absolutePath: string,
    relativePath: string,
  ): Promise<boolean> {
    try {
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        this.logger.debug("agent-tt skip (not a file)", { relativePath });
        return true;
      }
      if (stats.size > MAX_FILE_SIZE_B) {
        this.logger.debug("agent-tt skip (file too large)", {
          relativePath,
          size: stats.size,
          maxSize: MAX_FILE_SIZE_B,
        });
        return true;
      }
    } catch (err) {
      const code = (err as any)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        this.logger.debug("agent-tt skip (missing path)", {
          relativePath,
          code,
        });
        return true;
      }
      this.logger.debug("agent-tt size check failed", { relativePath, err });
      return true;
    }
    return false;
  }

  private async waitForCommit(
    syncdoc: AgentSyncDoc,
    startPatchId: PatchId | undefined,
  ): Promise<PatchId | undefined> {
    if (this.writeCommitWaitMs <= 0 || this.disposed) return;
    return await new Promise<PatchId | undefined>((resolve) => {
      let settled = false;
      const finish = (patchId?: PatchId) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        syncdoc.off("change", onChange);
        resolve(patchId);
      };
      const checkForCommit = () => {
        if (this.disposed) {
          finish(undefined);
          return;
        }
        const patchId = this.getLatestPatchId(syncdoc);
        if (patchId && patchId !== startPatchId) {
          finish(patchId);
        }
      };
      const onChange = () => {
        checkForCommit();
      };
      const timer = setTimeout(() => finish(undefined), this.writeCommitWaitMs);
      timer.unref?.();
      syncdoc.on("change", onChange);
      checkForCommit();
    });
  }
}
