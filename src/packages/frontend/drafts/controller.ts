/*
 * DraftController is a small, testable state machine for composer drafts.
 * It owns in-memory text/composing state, handles debounced persistence,
 * and exposes a simple subscription API for React integration.
 */

import debounce from "lodash/debounce";
import type { DraftControllerOptions, DraftSnapshot } from "./types";

type DraftListener = (snapshot: DraftSnapshot) => void;

const DEFAULT_DEBOUNCE_MS = 300;

export class DraftController {
  private readonly key: string;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly onError?: (error: unknown) => void;
  private readonly ttlMs?: number;
  private readonly adapter: DraftControllerOptions["adapter"];
  private readonly debouncedPersist: ReturnType<typeof debounce>;
  private state: DraftSnapshot;
  private listeners = new Set<DraftListener>();
  private saveChain: Promise<void> = Promise.resolve();
  private initialized = false;
  private disposed = false;

  constructor(options: DraftControllerOptions) {
    this.key = options.key;
    this.adapter = options.adapter;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs;
    this.onError = options.onError;
    this.debouncedPersist = debounce(() => {
      void this.persist(this.getSnapshot());
    }, this.debounceMs);
    this.state = {
      text: options.initialText ?? "",
      updatedAt: options.initialUpdatedAt ?? 0,
      composing: false,
    };
  }

  async init(): Promise<DraftSnapshot> {
    if (this.initialized || this.disposed) {
      return this.getSnapshot();
    }
    this.initialized = true;
    const local = this.getSnapshot();
    let remote: DraftSnapshot | undefined;
    try {
      remote = await this.adapter.load(this.key);
    } catch (error) {
      this.onError?.(error);
    }
    if (this.disposed) {
      return this.getSnapshot();
    }
    if (remote == null) {
      if (local.text.trim().length > 0) {
        this.scheduleSave();
      }
      this.emit();
      return this.getSnapshot();
    }
    if (remote.updatedAt >= local.updatedAt) {
      this.state = remote;
    } else if (local.text.trim().length > 0) {
      this.scheduleSave();
    }
    this.emit();
    return this.getSnapshot();
  }

  getSnapshot(): DraftSnapshot {
    return { ...this.state };
  }

  subscribe(listener: DraftListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  setText(text: string, { persist = true }: { persist?: boolean } = {}): void {
    if (this.disposed) return;
    if (text === this.state.text) return;
    this.state = {
      ...this.state,
      text,
      updatedAt: this.now(),
    };
    this.emit();
    if (persist) {
      this.scheduleSave();
    }
  }

  setComposing(
    composing: boolean,
    { persist = true }: { persist?: boolean } = {},
  ): void {
    if (this.disposed) return;
    if (composing === this.state.composing) return;
    this.state = {
      ...this.state,
      composing,
      updatedAt: this.now(),
    };
    this.emit();
    if (persist) {
      this.scheduleSave();
    }
  }

  async flush(): Promise<void> {
    if (this.disposed) return;
    this.debouncedPersist.cancel();
    await this.persist(this.getSnapshot());
  }

  async clear(): Promise<void> {
    if (this.disposed) return;
    this.debouncedPersist.cancel();
    this.state = {
      text: "",
      composing: false,
      updatedAt: this.now(),
    };
    this.emit();
    this.enqueue(async () => {
      await this.adapter.clear(this.key);
    });
    await this.saveChain;
  }

  async dispose({
    flush = false,
  }: {
    flush?: boolean;
  } = {}): Promise<void> {
    if (this.disposed) return;
    if (flush) {
      await this.flush();
    } else {
      this.debouncedPersist.cancel();
    }
    this.disposed = true;
    this.listeners.clear();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private scheduleSave(): void {
    this.debouncedPersist();
  }

  private async persist(snapshot: DraftSnapshot): Promise<void> {
    this.enqueue(async () => {
      await this.adapter.save(this.key, snapshot, { ttlMs: this.ttlMs });
    });
    await this.saveChain;
  }

  private enqueue(fn: () => Promise<void>): void {
    this.saveChain = this.saveChain
      .then(fn)
      .catch((error) => {
        this.onError?.(error);
      });
  }
}
