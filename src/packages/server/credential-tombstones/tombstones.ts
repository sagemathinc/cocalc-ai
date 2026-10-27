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
// credential is erased, even if its content can't be read. Names are a
// domain-separated SHA-256 of the credential's random id, never keyed by a
// rotating secret, so a tombstone is found the same way forever.
//
// Production stores tombstones in a GCS bucket with a locked retention
// policy, written by a service account that can only create, get and list
// (gcs-store.ts). LocalTombstoneStore is a stand-in with the same
// create-only rules for development and tests.

import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const TOMBSTONE_PREFIX = "credential-tombstones/v1/";
const NAME_DOMAIN = "cocalc-credential-tombstone:v1\0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[0-9a-f]{64}$/;

export type ErasureReason =
  | "owner_removed"
  | "replaced"
  | "account_deleted"
  | "membership_lapsed"
  | "admin"
  | "migration";

// Minimal and non-secret: no owner, no key material, no fingerprint.
export interface TombstoneContent {
  v: 1;
  kind: string;
  provider: string;
  erased_at: string;
  reason: ErasureReason;
}

// The raw object store. create() must be create-only (never overwrite), and
// the store must offer no way to delete. list() must return every name under
// the prefix (without the prefix) or throw: never a partial result.
export interface TombstoneObjectStore {
  create(name: string, body: Buffer): Promise<"created" | "exists">;
  get(name: string): Promise<Buffer | undefined>;
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

export interface TombstoneListing {
  names: ReadonlySet<string>;
  listedAt: number;
}

export class TombstoneLog {
  constructor(private readonly store: TombstoneObjectStore) {}

  // Write the tombstone, then read it back. Idempotent: an existing
  // tombstone for this credential counts as written.
  async append(credentialId: string, content: TombstoneContent): Promise<void> {
    const name = tombstoneName(credentialId);
    try {
      await this.store.create(name, Buffer.from(JSON.stringify(content)));
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
      return (await this.store.get(name)) !== undefined;
    } catch {
      throw new TombstoneUnavailableError();
    }
  }

  // The complete set of tombstone names. An unreachable store throws
  // TombstoneUnavailableError; a listing with names that aren't tombstone
  // names (or duplicates) throws TombstoneIntegrityError.
  async listAll(now: number = Date.now()): Promise<TombstoneListing> {
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
    return { names: set, listedAt: now };
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

  async get(name: string): Promise<Buffer | undefined> {
    checkTombstoneName(name);
    try {
      return await readFile(join(this.dir, name));
    } catch (err: any) {
      if (err?.code === "ENOENT") return undefined;
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
