/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  COLLABORATION_RELATION_MANIFEST_BYTES,
  COLLABORATION_RELATION_PAGE_BYTES,
  COLLABORATION_RELATION_PAGE_ROWS,
  COLLABORATION_RELATION_SET_BYTES,
  COLLABORATION_RELATION_SET_PAGES,
  COLLABORATION_RELATION_SET_ROWS,
  collaborationRelationBytes,
  collaborationRelationKey,
  validateCollaborationRelation,
  validateCollaborationRelationManifest,
  validateCollaborationRelationPage,
  validateCollaborationRelationSnapshot,
} from "./collaboration-relations";
import type {
  CollaborationRelation,
  CollaborationRelationManifest,
  CollaborationRelationPage,
  CollaborationRelationSnapshot,
  VerifiedCollaborationRelationSet,
} from "./collaboration-relations";

const PLACEHOLDER_DIGEST = "0".repeat(64);
const encoder = new TextEncoder();
const verifiedSets = new WeakSet<VerifiedCollaborationRelationSet>();
type Stream<T> = Iterable<T> | AsyncIterable<T>;

async function sha256(domain: "page" | "set", body: unknown): Promise<string> {
  const bytes = encoder.encode(
    `cocalc-collaboration-relation-${domain}-v1\n${JSON.stringify(body)}`,
  );
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}

function pageBody(page: CollaborationRelationPage) {
  const { digest: _digest, ...body } = page;
  return body;
}

async function setDigest(
  manifest: CollaborationRelationManifest,
  page_digests: readonly string[],
): Promise<string> {
  const { digest: _digest, ...body } = manifest;
  return await sha256("set", { ...body, page_digests });
}

function parse(value: string, max: number): unknown {
  if (
    typeof value !== "string" ||
    value.length > max ||
    collaborationRelationBytes(value) > max
  )
    throw Error("relation wire byte limit exceeded");
  return JSON.parse(value);
}

export function encodeCollaborationRelationManifest(
  value: CollaborationRelationManifest,
): string {
  return JSON.stringify(validateCollaborationRelationManifest(value));
}

/** Decoding a manifest does not prove completeness; verify its staged pages. */
export function decodeCollaborationRelationManifest(
  value: string,
): CollaborationRelationManifest {
  return validateCollaborationRelationManifest(
    parse(value, COLLABORATION_RELATION_MANIFEST_BYTES),
  );
}

export async function verifyCollaborationRelationPage(
  value: unknown,
  expected?: CollaborationRelationSnapshot,
): Promise<CollaborationRelationPage> {
  const page = validateCollaborationRelationPage(value, expected);
  if ((await sha256("page", pageBody(page))) !== page.digest)
    throw Error("relation page digest mismatch");
  return page;
}

export async function encodeCollaborationRelationPage(
  value: CollaborationRelationPage,
): Promise<string> {
  return JSON.stringify(await verifyCollaborationRelationPage(value));
}

export async function decodeCollaborationRelationPage(
  value: string,
  expected?: CollaborationRelationSnapshot,
): Promise<CollaborationRelationPage> {
  return await verifyCollaborationRelationPage(
    parse(value, COLLABORATION_RELATION_PAGE_BYTES),
    expected,
  );
}

/** An existing immutable (snapshot,page) slot accepts only an identical retry. */
export async function assertCollaborationRelationPageReplay(
  existing: CollaborationRelationPage,
  candidate: CollaborationRelationPage,
): Promise<void> {
  const a = await verifyCollaborationRelationPage(existing);
  const b = await verifyCollaborationRelationPage(candidate, a.snapshot);
  if (a.page !== b.page || a.digest !== b.digest)
    throw Error("conflicting immutable relation page replay");
}

/**
 * Input must be deduplicated and ordered by collaborationRelationKey using binary
 * JS string order, NOT localeCompare. The producer can supply a SQLite-backed
 * iterator. At most one page plus bounded page digests is retained here.
 *
 * stage must persist hidden, immutable pages only. Failure may leave staged
 * pages, but returns no manifest. A caller must not activate on this callback.
 */
export async function createCollaborationRelationSet(
  source: CollaborationRelationSnapshot,
  input: Stream<CollaborationRelation>,
  stage: (page: CollaborationRelationPage) => void | Promise<void>,
): Promise<CollaborationRelationManifest> {
  const snapshot = validateCollaborationRelationSnapshot(source);
  const manifest: CollaborationRelationManifest = {
    version: 1,
    snapshot,
    page_count: 0,
    participant_count: 0,
    reference_count: 0,
    byte_count: 0,
    digest: PLACEHOLDER_DIGEST,
  };
  const page_digests: string[] = [];
  let rows: CollaborationRelation[] = [];
  let previous: string | undefined;
  function pending(): CollaborationRelationPage {
    return {
      version: 1,
      snapshot,
      page: manifest.page_count,
      rows,
      digest: PLACEHOLDER_DIGEST,
    };
  }
  async function flush() {
    if (!rows.length) return;
    if (manifest.page_count >= COLLABORATION_RELATION_SET_PAGES)
      throw Error("relation set page limit exceeded");
    const page = validateCollaborationRelationPage(pending());
    page.digest = await sha256("page", pageBody(page));
    manifest.byte_count += collaborationRelationBytes(JSON.stringify(page));
    if (manifest.byte_count > COLLABORATION_RELATION_SET_BYTES)
      throw Error("relation set byte limit exceeded");
    const hash = page.digest;
    await stage(page);
    page_digests.push(hash);
    manifest.page_count++;
    rows = [];
  }
  for await (const inputRow of input) {
    const row = validateCollaborationRelation(inputRow);
    const key = collaborationRelationKey(row);
    if (previous !== undefined && key <= previous)
      throw Error("relation rows must be strictly ordered and unique");
    previous = key;
    if (row.kind === "participant") manifest.participant_count++;
    else manifest.reference_count++;
    if (
      manifest.participant_count + manifest.reference_count >
      COLLABORATION_RELATION_SET_ROWS
    )
      throw Error("relation set row limit exceeded");
    rows.push(row);
    if (
      collaborationRelationBytes(JSON.stringify(pending())) >
      COLLABORATION_RELATION_PAGE_BYTES
    ) {
      rows.pop();
      await flush();
      rows.push(row);
    }
    if (rows.length === COLLABORATION_RELATION_PAGE_ROWS) await flush();
  }
  await flush();
  manifest.digest = await setDigest(manifest, page_digests);
  return validateCollaborationRelationManifest(manifest);
}

/**
 * Read staged pages in numeric page order under the adapter's lifecycle fence.
 * Only this full check yields a commit candidate. Neither per-page ACKs nor
 * manifest decoding permit partial activation. Adapters must atomically flip the
 * active pointer with their catalog revision, after rechecking the writer fence.
 */
export async function verifyCollaborationRelationSet(
  value: unknown,
  input: Stream<CollaborationRelationPage>,
): Promise<VerifiedCollaborationRelationSet> {
  const manifest = validateCollaborationRelationManifest(value);
  const page_digests: string[] = [];
  let participant_count = 0,
    reference_count = 0,
    byte_count = 0;
  let previous: string | undefined;
  for await (const value of input) {
    if (page_digests.length >= manifest.page_count)
      throw Error("unexpected relation page");
    const page = await verifyCollaborationRelationPage(
      value,
      manifest.snapshot,
    );
    if (page.page !== page_digests.length)
      throw Error("missing or out-of-order relation page");
    for (const row of page.rows) {
      const key = collaborationRelationKey(row);
      if (previous !== undefined && key <= previous)
        throw Error("relation set rows must be strictly ordered and unique");
      previous = key;
      if (row.kind === "participant") participant_count++;
      else reference_count++;
    }
    byte_count += collaborationRelationBytes(JSON.stringify(page));
    if (
      participant_count > manifest.participant_count ||
      reference_count > manifest.reference_count ||
      byte_count > manifest.byte_count
    )
      throw Error("relation set exceeds manifest totals");
    page_digests.push(page.digest);
  }
  if (
    page_digests.length !== manifest.page_count ||
    participant_count !== manifest.participant_count ||
    reference_count !== manifest.reference_count ||
    byte_count !== manifest.byte_count
  )
    throw Error("incomplete relation set");
  if ((await setDigest(manifest, page_digests)) !== manifest.digest)
    throw Error("relation set digest mismatch");
  Object.freeze(manifest.snapshot);
  const verified = Object.freeze(manifest) as VerifiedCollaborationRelationSet;
  verifiedSets.add(verified);
  return verified;
}

/**
 * expected is the admitted source snapshot, with the authoritative writer epoch
 * already checked under the adapter's lock. committed, when provided, comes ONLY
 * from the active committed pointer, never from a staged/client-supplied manifest.
 *
 * Notification-only snapshots may reuse the exact committed set at an older
 * sequence. A newly staged old/future sequence, conflicting retry, mixed source,
 * or mixed epoch is rejected. New epochs may replace old epochs only via the
 * caller's authoritative admission, not by comparing opaque epoch strings.
 */
export function collaborationRelationActivation(
  verified: VerifiedCollaborationRelationSet,
  expected: CollaborationRelationSnapshot,
  committed?: CollaborationRelationManifest,
): "activate" | "reuse" {
  if (!verifiedSets.has(verified)) throw Error("unverified relation set");
  const manifest = validateCollaborationRelationManifest(verified);
  const snapshot = validateCollaborationRelationSnapshot(expected);
  const active = committed && validateCollaborationRelationManifest(committed);
  const sameSource = (
    a: CollaborationRelationSnapshot,
    b: CollaborationRelationSnapshot,
  ) => a.project_id === b.project_id && a.chat_path === b.chat_path;
  if (
    !sameSource(manifest.snapshot, snapshot) ||
    manifest.snapshot.epoch !== snapshot.epoch ||
    (active && !sameSource(active.snapshot, snapshot))
  )
    throw Error("relation activation source/epoch mismatch");
  if (manifest.snapshot.sequence > snapshot.sequence)
    throw Error("future relation set sequence");
  if (active?.snapshot.epoch === snapshot.epoch) {
    if (active.snapshot.sequence > manifest.snapshot.sequence)
      throw Error("stale relation set sequence");
    if (active.snapshot.sequence === manifest.snapshot.sequence) {
      if (JSON.stringify(active) !== JSON.stringify(manifest))
        throw Error("conflicting committed relation manifest");
      return "reuse";
    }
  }
  if (manifest.snapshot.sequence !== snapshot.sequence)
    throw Error("uncommitted old relation set sequence");
  return "activate";
}
