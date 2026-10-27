/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Credential tombstones in a GCS bucket, through the JSON API.
//
// The bucket is expected to have a locked retention policy and the service
// account only storage.objects.create/get/list on it. This client only ever
// creates with ifGenerationMatch=0 (fails if the object exists), reads object
// metadata (never content) and lists; it has no delete or overwrite path.

import { GoogleAuth } from "google-auth-library";
import {
  checkTombstoneName,
  TOMBSTONE_PREFIX,
  TombstoneIntegrityError,
  type TombstoneObjectStore,
} from "./tombstones";

const API = "https://storage.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";
const REQUEST_TIMEOUT_MS = 15_000;
// One budget for a whole listing, so a misbehaving API can't hold the
// restore gate for hours.
const LIST_DEADLINE_MS = 5 * 60_000;
const MAX_PAGES = 10_000;

type Fetch = typeof globalThis.fetch;

export interface GcsTombstoneStoreOptions {
  bucket: string;
  // Defaults to Application Default Credentials (the bay's service account).
  getAccessToken?: () => Promise<string>;
  fetch?: Fetch;
  now?: () => number;
}

export class GcsTombstoneStore implements TombstoneObjectStore {
  private readonly bucket: string;
  private readonly token: () => Promise<string>;
  private readonly fetch: Fetch;
  private readonly now: () => number;

  constructor(opts: GcsTombstoneStoreOptions) {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(opts.bucket ?? "")) {
      throw new Error("invalid GCS bucket name");
    }
    this.bucket = opts.bucket;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    if (opts.getAccessToken) {
      this.token = opts.getAccessToken;
    } else {
      const auth = new GoogleAuth({ scopes: [SCOPE] });
      this.token = async () => {
        const token = await auth.getAccessToken();
        if (!token) throw new Error("no GCS access token");
        return token;
      };
    }
  }

  async create(name: string, body: Buffer): Promise<"created" | "exists"> {
    checkTombstoneName(name);
    const params = new URLSearchParams({
      uploadType: "media",
      name: `${TOMBSTONE_PREFIX}${name}`,
      ifGenerationMatch: "0",
    });
    const res = await this.request(
      `${API}/upload/storage/v1/b/${this.bucket}/o?${params}`,
      { method: "POST", body, contentType: "application/json" },
    );
    discard(res);
    if (res.status === 412) return "exists";
    if (!res.ok) throw new Error(`GCS create failed (${res.status})`);
    return "created";
  }

  // Presence from object metadata; the content is never downloaded.
  async exists(name: string): Promise<boolean> {
    checkTombstoneName(name);
    const full = `${TOMBSTONE_PREFIX}${name}`;
    const params = new URLSearchParams({ fields: "name" });
    const res = await this.request(
      `${API}/storage/v1/b/${this.bucket}/o/${encodeURIComponent(full)}?${params}`,
      { method: "GET" },
    );
    discard(res);
    if (res.ok) return true;
    if (res.status !== 404) throw new Error(`GCS get failed (${res.status})`);
    // A deleted or misnamed bucket also answers 404. Only an exact-prefix
    // listing that succeeds (so the bucket exists) and finds nothing proves
    // the object is absent. (The service account can't read bucket metadata,
    // but it can list.) An object appearing in between counts as present.
    const page = await this.listPage(
      { prefix: full, maxResults: "1" },
      this.now() + REQUEST_TIMEOUT_MS,
    );
    return page.names.length > 0;
  }

  async list(): Promise<string[]> {
    const deadline = this.now() + LIST_DEADLINE_MS;
    const names: string[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.listPage(
        { prefix: TOMBSTONE_PREFIX, maxResults: "1000", pageToken },
        deadline,
      );
      names.push(...result.names);
      if (result.nextPageToken === undefined) return names;
      if (seenTokens.has(result.nextPageToken)) {
        throw new TombstoneIntegrityError();
      }
      seenTokens.add(result.nextPageToken);
      pageToken = result.nextPageToken;
    }
    throw new TombstoneIntegrityError();
  }

  // One page of objects.list. Anything but a well-formed answer throws: a
  // missing bucket, an error status or the deadline as an outage, a
  // malformed body as an integrity failure. Never an empty listing by
  // default.
  private async listPage(
    opts: { prefix: string; maxResults: string; pageToken?: string },
    deadline: number,
  ): Promise<{ names: string[]; nextPageToken?: string }> {
    if (this.now() >= deadline) throw new Error("GCS list deadline exceeded");
    const params = new URLSearchParams({
      prefix: opts.prefix,
      fields: "items(name),nextPageToken",
      maxResults: opts.maxResults,
    });
    if (opts.pageToken) params.set("pageToken", opts.pageToken);
    const res = await this.request(
      `${API}/storage/v1/b/${this.bucket}/o?${params}`,
      { method: "GET" },
      Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - this.now())),
    );
    if (!res.ok) {
      discard(res);
      throw new Error(`GCS list failed (${res.status})`);
    }
    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new TombstoneIntegrityError();
    }
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      throw new TombstoneIntegrityError();
    }
    // GCS omits `items` for an empty result; when present it must be a list.
    const items = "items" in body ? body.items : [];
    if (!Array.isArray(items)) throw new TombstoneIntegrityError();
    const names: string[] = [];
    for (const item of items) {
      const full = item?.name;
      if (typeof full !== "string" || !full.startsWith(TOMBSTONE_PREFIX)) {
        throw new TombstoneIntegrityError();
      }
      names.push(full.slice(TOMBSTONE_PREFIX.length));
    }
    // Only an absent token ends the listing; null, "" or a non-string is
    // malformed and must not truncate it.
    if (!("nextPageToken" in body)) return { names };
    const next = body.nextPageToken;
    if (typeof next !== "string" || !next) throw new TombstoneIntegrityError();
    return { names, nextPageToken: next };
  }

  private async request(
    url: string,
    opts: { method: string; body?: Buffer; contentType?: string },
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const token = await this.token();
    return await this.fetch(url, {
      method: opts.method,
      body: opts.body,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.contentType ? { "Content-Type": opts.contentType } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}

// Don't read bodies we don't need.
function discard(res: Response): void {
  res.body?.cancel().catch(() => {});
}
