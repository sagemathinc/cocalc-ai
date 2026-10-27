/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Off-host, append-only erasure tombstones for user-provided credentials
// (API keys and tokens customers give CoCalc, e.g. for OpenAI, Anthropic or
// RunPod).
//
// The database row is the immediate revocation mechanism; tombstones are the
// rollback/restore mechanism. A credential is erased by first denying it in
// the database, then writing (and reading back) its tombstone here, then
// removing its ciphertext. A database, disk or DR restore from before an
// erasure brings the row back, but not past the tombstone: decrypts check
// the tombstone set, and after any restore the set is reconciled into the
// database before any credential is usable.
//
// Presence decides: any object at a credential's tombstone name means the
// credential is erased, whatever its content. Names are a domain-separated
// SHA-256 of the credential's random id, never keyed by a rotating secret, so
// a tombstone is found the same way forever.
//
// Production stores tombstones in a GCS bucket with a locked retention
// policy, written by a service account that can only create, get and list
// (gcs-store.ts). LocalTombstoneStore is a stand-in with the same
// create-only rules for development and tests.

import { createHash } from "node:crypto";
import { mkdir, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const TOMBSTONE_PREFIX = "credential-tombstones/v1/";
const NAME_DOMAIN = "cocalc-credential-tombstone:v1\0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const MAX_TOMBSTONE_BYTES = 512;

export const ERASURE_REASONS = [
  "owner_removed",
  "replaced",
  "account_deleted",
  "membership_lapsed",
  "admin",
  "migration",
] as const;
export type ErasureReason = (typeof ERASURE_REASONS)[number];

// What a caller provides. The stored object is rebuilt from exactly these
// validated fields, so nothing else (a secret, an owner id) can ever be
// written into the non-deletable store.
export interface TombstoneContent {
  kind: string;
  provider: string;
  erasedAt: Date;
  reason: ErasureReason;
}

// The raw object store. create() must be create-only (never overwrite), and
// the store must offer no way to delete. exists() answers presence only.
// list() returns names under the prefix (without it), or throws; see
// TombstoneLog.listAll for what a listing guarantees.
export interface TombstoneObjectStore {
  create(name: string, body: Buffer): Promise<"created" | "exists">;
  exists(name: string): Promise<boolean>;
  list(): Promise<string[]>;
}

export class TombstoneUnavailableError extends Error {
  constructor(message = "the credential tombstone log is unavailable") {
    super(message);
    this.name = "TombstoneUnavailableError";
  }
}

// A listing that is malformed or can't be trusted. Unlike an outage, this
// must close the restore gate.
export class TombstoneIntegrityError extends Error {
  constructor(message = "the credential tombstone listing is not valid") {
    super(message);
    this.name = "TombstoneIntegrityError";
  }
}

export function tombstoneName(credentialId: string): string {
  const id = `${credentialId ?? ""}`.trim().toLowerCase();
  if (!UUID.test(id)) throw new Error("invalid credential id");
  return createHash("sha256").update(NAME_DOMAIN).update(id).digest("hex");
}

// The exact bytes stored for a tombstone. Throws on any invalid field.
export function tombstoneBody(content: TombstoneContent): Buffer {
  const kind = `${content?.kind ?? ""}`;
  const provider = `${content?.provider ?? ""}`;
  const reason = content?.reason;
  const erasedAt = content?.erasedAt;
  if (!SLUG.test(kind)) throw new Error("invalid tombstone kind");
  if (!SLUG.test(provider)) throw new Error("invalid tombstone provider");
  if (!(ERASURE_REASONS as readonly string[]).includes(reason)) {
    throw new Error("invalid tombstone reason");
  }
  if (!(erasedAt instanceof Date) || !Number.isFinite(erasedAt.getTime())) {
    throw new Error("invalid tombstone time");
  }
  const erased_at = erasedAt.toISOString();
  if (!ISO_UTC.test(erased_at)) throw new Error("invalid tombstone time");
  const body = Buffer.from(
    JSON.stringify({ v: 1, kind, provider, erased_at, reason }),
  );
  if (body.length > MAX_TOMBSTONE_BYTES) throw new Error("tombstone too large");
  return body;
}

// A listing is complete for every tombstone created before
// `completeThrough` (the time the listing started). Tombstones appended
// while it ran may be missing: object stores page in name order, and a new
// name can sort before the current page. Callers must therefore never treat
// a credential as live just because it is absent from a listing; erasures
// after `completeThrough` are covered by the database deny state, which an
// erasure commits before it appends its tombstone.
export interface TombstoneListing {
  names: ReadonlySet<string>;
  completeThrough: number;
}

export class TombstoneLog {
  constructor(
    private readonly store: TombstoneObjectStore,
    private readonly now: () => number = Date.now,
  ) {}

  // Write the tombstone, then confirm it is present. Idempotent: an
  // existing tombstone for this credential counts as written.
  async append(credentialId: string, content: TombstoneContent): Promise<void> {
    const name = tombstoneName(credentialId);
    const body = tombstoneBody(content);
    try {
      await this.store.create(name, body);
    } catch {
      throw new TombstoneUnavailableError();
    }
    if (!(await this.isTombstoned(credentialId))) {
      throw new TombstoneUnavailableError(
        "the credential tombstone could not be read back",
      );
    }
  }

  // Throws TombstoneUnavailableError when the log can't answer.
  async isTombstoned(credentialId: string): Promise<boolean> {
    const name = tombstoneName(credentialId);
    try {
      return await this.store.exists(name);
    } catch {
      throw new TombstoneUnavailableError();
    }
  }

  // Every tombstone created before the listing started (see
  // TombstoneListing). An unreachable store throws
  // TombstoneUnavailableError; a malformed listing (foreign or duplicate
  // names, a bad page) throws TombstoneIntegrityError.
  async listAll(): Promise<TombstoneListing> {
    const completeThrough = this.now();
    let names: string[];
    try {
      names = await this.store.list();
    } catch (err) {
      if (err instanceof TombstoneIntegrityError) throw err;
      throw new TombstoneUnavailableError();
    }
    if (!Array.isArray(names) || names.some((n) => !NAME.test(n))) {
      throw new TombstoneIntegrityError();
    }
    const set = new Set(names);
    if (set.size !== names.length) throw new TombstoneIntegrityError();
    return { names: set, completeThrough };
  }
}

// Local stand-in for the bucket: one file per tombstone, created with
// O_EXCL so an existing tombstone is never overwritten. No delete API.
export class LocalTombstoneStore implements TombstoneObjectStore {
  constructor(private readonly dir: string) {}

  async create(name: string, body: Buffer): Promise<"created" | "exists"> {
    checkTombstoneName(name);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(join(this.dir, name), "wx", 0o600);
    } catch (err: any) {
      if (err?.code === "EEXIST") return "exists";
      throw err;
    }
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return "created";
  }

  async exists(name: string): Promise<boolean> {
    checkTombstoneName(name);
    try {
      await stat(join(this.dir, name));
      return true;
    } catch (err: any) {
      if (err?.code === "ENOENT") return false;
      throw err;
    }
  }

  async list(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((n) => !n.startsWith("."));
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  }
}

export function checkTombstoneName(name: string): void {
  if (!NAME.test(name)) throw new Error("invalid tombstone name");
}
