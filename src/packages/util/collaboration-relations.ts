/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationSourceSnapshot } from "./collaborators";
import type { CollaborationReference } from "./collaboration-references";
import type { CollaborationTarget } from "./collaborators";

export type CollaborationRelationQuery = CollaborationTarget & {
  account_id?: string;
  after?: string;
  limit?: number;
  message_id?: string;
};

/** Trusted owner-to-home continuation, bound to the catalog resource revision. */
export interface CollaborationParticipantContinuation {
  count: number;
  entry_key: string;
  revision: number;
  set_key: string;
  thread_key: string;
  after: string;
}
export interface CollaborationParticipantProjection {
  set_key: string;
  thread_key: string;
  /** null denotes the first page, not a truncated participant preview. */
  after: string | null;
  ids: string[];
  count: number;
  complete: boolean;
}

export const COLLABORATION_RELATION_VERSION = 1;
export const COLLABORATION_RELATION_PAGE_ROWS = 200;
export const COLLABORATION_RELATION_PAGE_BYTES = 256 * 1024;
export const COLLABORATION_RELATION_ROW_BYTES = 4096;
export const COLLABORATION_RELATION_SET_ROWS = 1_000_000;
export const COLLABORATION_RELATION_SET_BYTES = 64 * 1024 * 1024;
export const COLLABORATION_RELATION_SET_PAGES = 10_000;
export const COLLABORATION_RELATION_MANIFEST_BYTES = 4096;

/** Reuse the source writer fence; there is no separate upload/session identity. */
export type CollaborationRelationSnapshot = Pick<
  CollaborationSourceSnapshot,
  "project_id" | "chat_path" | "epoch" | "sequence"
>;

/**
 * Native extraction identity, BEFORE registered-agent adaptation. resource_id
 * includes any copy namespace; thread_id remains the native durable thread ID.
 * An owner stores its verified canonical entry binding separately, never by
 * rewriting this provenance or re-resolving an authored reference's target.
 */
export interface CollaborationRelationThread {
  kind: "agent" | "conversation";
  resource_id: string;
  thread_id: string;
}

export interface CollaborationParticipantRelation {
  kind: "participant";
  source: CollaborationRelationThread;
  account_id: string;
}

export interface CollaborationReferenceRelation {
  kind: "reference";
  source: CollaborationRelationThread;
  message_id: string;
  /** Identity only: no message body, display fallback, personal alias, or ACL. */
  reference: Pick<CollaborationReference, "version" | "target">;
}

export type CollaborationRelation =
  | CollaborationParticipantRelation
  | CollaborationReferenceRelation;

/**
 * Immutable staging row, keyed by (snapshot, page). Conflicting retries are
 * errors, not replacement writes. A valid page alone MUST NOT become visible.
 * digest is SHA-256 of the domain-separated canonical page body (without digest).
 */
export interface CollaborationRelationPage {
  version: 1;
  snapshot: CollaborationRelationSnapshot;
  page: number;
  rows: CollaborationRelation[];
  digest: string;
}

/**
 * Complete replacement of both relation kinds for one source snapshot. Counts
 * count edges, not people across a project. byte_count sums canonical page wire
 * bytes. digest binds this manifest body and the ordered page digests.
 *
 * Absence means unknown/indexing, NOT an empty relation. Only an explicitly
 * verified zero-page manifest clears a set. There is no partial-activation flag.
 */
export interface CollaborationRelationManifest {
  version: 1;
  snapshot: CollaborationRelationSnapshot;
  page_count: number;
  participant_count: number;
  reference_count: number;
  byte_count: number;
  digest: string;
}

declare const verifiedRelationSet: unique symbol;
/** Produced by complete-set verification, not structural manifest validation. */
export type VerifiedCollaborationRelationSet =
  Readonly<CollaborationRelationManifest> & {
    readonly [verifiedRelationSet]: true;
  };

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const UNPAIRED_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
const encoder = new TextEncoder();

export function collaborationRelationBytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function object(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    throw Error(`invalid relation ${label}`);
  const keys = Object.keys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => !fields.includes(key))
  )
    throw Error(`invalid relation ${label} fields`);
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  max: number,
  label: string,
  maxBytes = max,
): string {
  if (
    typeof value !== "string" ||
    !value.trim().length ||
    value.length > max ||
    collaborationRelationBytes(value) > maxBytes ||
    CONTROL.test(value) ||
    UNPAIRED_SURROGATE.test(value)
  )
    throw Error(`invalid relation ${label}`);
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw Error(`invalid relation ${label}`);
  return value.toLowerCase();
}

function integer(value: unknown, max: number, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    throw Error(`invalid relation ${label}`);
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value))
    throw Error("invalid relation digest");
  return value;
}

export function validateCollaborationRelationSnapshot(
  value: unknown,
): CollaborationRelationSnapshot {
  const v = object(
    value,
    ["project_id", "chat_path", "epoch", "sequence"],
    "snapshot",
  );
  const chat_path = text(v.chat_path, 1024, "chat_path");
  const parts = chat_path.split("/");
  if (
    !chat_path.startsWith("/") ||
    !/\.(sage-)?chat$/.test(chat_path) ||
    parts.slice(1).some((part) => !part || part === "." || part === "..")
  )
    throw Error("relation chat_path must be a canonical absolute .chat path");
  const sequence = integer(v.sequence, Number.MAX_SAFE_INTEGER, "sequence");
  if (sequence === 0) throw Error("invalid relation sequence");
  return {
    project_id: uuid(v.project_id, "project_id"),
    chat_path,
    epoch: uuid(v.epoch, "epoch"),
    sequence,
  };
}

function thread(value: unknown): CollaborationRelationThread {
  const v = object(
    value,
    ["kind", "resource_id", "thread_id"],
    "source thread",
  );
  if (v.kind !== "agent" && v.kind !== "conversation")
    throw Error("invalid relation source kind");
  return {
    kind: v.kind,
    resource_id: text(v.resource_id, 256, "source resource_id"),
    thread_id: text(v.thread_id, 256, "source thread_id"),
  };
}

export function validateCollaborationRelation(
  value: unknown,
): CollaborationRelation {
  const kind = (value as { kind?: unknown } | null)?.kind;
  let row: CollaborationRelation;
  if (kind === "participant") {
    const v = object(value, ["kind", "source", "account_id"], "participant");
    row = {
      kind,
      source: thread(v.source),
      account_id: uuid(v.account_id, "participant account_id"),
    };
  } else if (kind === "reference") {
    const v = object(
      value,
      ["kind", "source", "message_id", "reference"],
      "reference edge",
    );
    const reference = object(v.reference, ["version", "target"], "reference");
    const target = object(
      reference.target,
      ["project_id", "kind", "resource_id"],
      "target",
    );
    if (
      reference.version !== 1 ||
      (target.kind !== "agent" &&
        target.kind !== "artifact" &&
        target.kind !== "conversation")
    )
      throw Error("invalid relation reference version/kind");
    row = {
      kind,
      source: thread(v.source),
      message_id: text(v.message_id, 256, "message_id"),
      reference: {
        version: 1,
        target: {
          project_id: uuid(target.project_id, "target project_id"),
          kind: target.kind,
          // Authored reference IDs use the shared codec's 256-character limit.
          resource_id: text(
            target.resource_id,
            256,
            "target resource_id",
            1024,
          ),
        },
      },
    };
  } else throw Error("invalid relation kind");
  if (
    collaborationRelationBytes(JSON.stringify(row)) >
    COLLABORATION_RELATION_ROW_BYTES
  )
    throw Error("relation row byte limit exceeded");
  return row;
}

/** ASCII key: JS string order and SQLite/Postgres binary order agree, even for Unicode IDs. */
export function collaborationRelationKey(value: CollaborationRelation): string {
  const row = validateCollaborationRelation(value);
  const prefix = [
    row.kind,
    row.source.kind,
    row.source.resource_id,
    row.source.thread_id,
  ];
  return JSON.stringify(
    row.kind === "participant"
      ? [...prefix, row.account_id]
      : [
          ...prefix,
          row.message_id,
          row.reference.version,
          row.reference.target.project_id,
          row.reference.target.kind,
          row.reference.target.resource_id,
        ],
  ).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function collaborationRelationSetKey(
  value: CollaborationRelationSnapshot,
): string {
  const v = validateCollaborationRelationSnapshot(value);
  return JSON.stringify([v.project_id, v.chat_path, v.epoch, v.sequence]);
}

/** Structural validation is NOT evidence that all pages have arrived. */
export function validateCollaborationRelationManifest(
  value: unknown,
): CollaborationRelationManifest {
  const v = object(
    value,
    [
      "version",
      "snapshot",
      "page_count",
      "participant_count",
      "reference_count",
      "byte_count",
      "digest",
    ],
    "manifest",
  );
  if (v.version !== 1) throw Error("unsupported relation manifest version");
  const manifest: CollaborationRelationManifest = {
    version: 1,
    snapshot: validateCollaborationRelationSnapshot(v.snapshot),
    page_count: integer(
      v.page_count,
      COLLABORATION_RELATION_SET_PAGES,
      "page_count",
    ),
    participant_count: integer(
      v.participant_count,
      COLLABORATION_RELATION_SET_ROWS,
      "participant_count",
    ),
    reference_count: integer(
      v.reference_count,
      COLLABORATION_RELATION_SET_ROWS,
      "reference_count",
    ),
    byte_count: integer(
      v.byte_count,
      COLLABORATION_RELATION_SET_BYTES,
      "byte_count",
    ),
    digest: digest(v.digest),
  };
  const rows = manifest.participant_count + manifest.reference_count;
  if (
    rows > COLLABORATION_RELATION_SET_ROWS ||
    rows > manifest.page_count * COLLABORATION_RELATION_PAGE_ROWS ||
    rows < manifest.page_count ||
    (manifest.page_count === 0 && manifest.byte_count !== 0) ||
    (manifest.page_count !== 0 && manifest.byte_count === 0) ||
    manifest.byte_count >
      manifest.page_count * COLLABORATION_RELATION_PAGE_BYTES ||
    collaborationRelationBytes(JSON.stringify(manifest)) >
      COLLABORATION_RELATION_MANIFEST_BYTES
  )
    throw Error("invalid relation manifest totals");
  return manifest;
}

/** Validate shape, budgets and ordering; cryptographic checks live in the codec. */
export function validateCollaborationRelationPage(
  value: unknown,
  expected?: CollaborationRelationSnapshot,
): CollaborationRelationPage {
  const v = object(
    value,
    ["version", "snapshot", "page", "rows", "digest"],
    "page",
  );
  if (v.version !== 1) throw Error("unsupported relation page version");
  const snapshot = validateCollaborationRelationSnapshot(v.snapshot);
  if (
    expected &&
    collaborationRelationSetKey(snapshot) !==
      collaborationRelationSetKey(expected)
  )
    throw Error("relation page snapshot mismatch");
  if (
    !Array.isArray(v.rows) ||
    !v.rows.length ||
    v.rows.length > COLLABORATION_RELATION_PAGE_ROWS
  )
    throw Error("relation page row limit exceeded");
  const rows = v.rows.map(validateCollaborationRelation);
  let previous: string | undefined;
  for (const row of rows) {
    const key = collaborationRelationKey(row);
    if (previous !== undefined && key <= previous)
      throw Error("relation rows must be strictly ordered and unique");
    previous = key;
  }
  const page: CollaborationRelationPage = {
    version: 1,
    snapshot,
    page: integer(v.page, COLLABORATION_RELATION_SET_PAGES - 1, "page"),
    rows,
    digest: digest(v.digest),
  };
  if (
    collaborationRelationBytes(JSON.stringify(page)) >
    COLLABORATION_RELATION_PAGE_BYTES
  )
    throw Error("relation page byte limit exceeded");
  return page;
}
