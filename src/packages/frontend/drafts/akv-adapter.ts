/*
 * AKV-backed draft adapter.
 * This stores drafts as versioned JSON payloads so format upgrades stay safe,
 * and supports TTL for automatic cleanup of stale composer drafts.
 */

import type {
  DraftSaveOptions,
  DraftSnapshot,
  DraftStorageAdapter,
} from "./types";

interface AKVLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options?: { ttl?: number }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

interface AkvDraftPayloadV1 {
  version: 1;
  text: string;
  updatedAt: number;
  composing?: boolean;
}

export interface AkvDraftAdapterOptions {
  kv: AKVLike;
  defaultTtlMs?: number;
}

function isPayloadV1(x: unknown): x is AkvDraftPayloadV1 {
  if (x == null || typeof x !== "object") return false;
  const y = x as Partial<AkvDraftPayloadV1>;
  if (y.version !== 1) return false;
  if (typeof y.text !== "string") return false;
  if (typeof y.updatedAt !== "number") return false;
  if (y.composing != null && typeof y.composing !== "boolean") return false;
  return true;
}

export class AkvDraftAdapter implements DraftStorageAdapter {
  private readonly kv: AKVLike;
  private readonly defaultTtlMs?: number;

  constructor(options: AkvDraftAdapterOptions) {
    this.kv = options.kv;
    this.defaultTtlMs = options.defaultTtlMs;
  }

  async load(key: string): Promise<DraftSnapshot | undefined> {
    const payload = await this.kv.get(key);
    if (!isPayloadV1(payload)) {
      return undefined;
    }
    return {
      text: payload.text,
      updatedAt: payload.updatedAt,
      composing: payload.composing ?? false,
    };
  }

  async save(
    key: string,
    snapshot: DraftSnapshot,
    options?: DraftSaveOptions,
  ): Promise<void> {
    const payload: AkvDraftPayloadV1 = {
      version: 1,
      text: snapshot.text,
      updatedAt: snapshot.updatedAt,
      composing: snapshot.composing,
    };
    const ttl = options?.ttlMs ?? this.defaultTtlMs;
    if (ttl == null) {
      await this.kv.set(key, payload);
      return;
    }
    await this.kv.set(key, payload, { ttl });
  }

  async clear(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}
