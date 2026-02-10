/*
 * Shared draft state contracts for rich input composers.
 * This keeps persistence and UI logic decoupled so chat/messages can reuse
 * the same state machine with different storage backends.
 */

export interface DraftSnapshot {
  text: string;
  updatedAt: number;
  composing: boolean;
}

export interface DraftSaveOptions {
  ttlMs?: number;
}

export interface DraftStorageAdapter {
  load(key: string): Promise<DraftSnapshot | undefined>;
  save(
    key: string,
    snapshot: DraftSnapshot,
    options?: DraftSaveOptions,
  ): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface DraftControllerOptions {
  key: string;
  adapter: DraftStorageAdapter;
  debounceMs?: number;
  now?: () => number;
  initialText?: string;
  initialUpdatedAt?: number;
  ttlMs?: number;
  onError?: (error: unknown) => void;
}
