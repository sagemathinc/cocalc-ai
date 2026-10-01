/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createMarkdownParser } from "@cocalc/util/markdown/parser";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import type { CollaborationReference } from "@cocalc/util/collaboration-references";
import {
  validateCollaborationRelation,
  collaborationRelationKey,
} from "@cocalc/util/collaboration-relations";
import type {
  CollaborationRelation,
  CollaborationRelationThread,
} from "@cocalc/util/collaboration-relations";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const parser = createMarkdownParser();

/** Capture before registered-agent adaptation; copy namespaces stay intact. */
export function nativeCollaborationRelationThreads(
  resources: readonly CollaborationResource[],
): CollaborationRelationThread[] {
  return resources.flatMap((resource) => {
    if (resource.kind === "artifact") return [];
    if (resource.agent_id)
      throw Error("relation extraction requires native thread provenance");
    return [
      {
        kind: resource.kind,
        resource_id: resource.resource_id,
        thread_id: resource.thread_id,
      },
    ];
  });
}

/** Current rendered reference atoms only, never labels, aliases, or inferred targets. */
export function* collaborationMessageReferences(
  text: string,
): Generator<Pick<CollaborationReference, "version" | "target">> {
  if (
    text.length > MAX_MESSAGE_BYTES ||
    encoder.encode(text).length > MAX_MESSAGE_BYTES
  )
    throw Error("collaboration reference message parsing capacity exceeded");
  for (const block of parser.parse(text, {})) {
    if (block.type !== "inline") continue;
    for (const token of block.children ?? []) {
      if (token.type !== "collaboration-reference") continue;
      const reference = (
        token as typeof token & { reference: CollaborationReference }
      ).reference;
      yield { version: 1, target: { ...reference.target } };
    }
  }
}

/**
 * Apply to resolved head/archive pages from one stable source read. This emits
 * facts, not a completeness claim: the caller must finish the archive before
 * sealing a replacement set. Cross-page deduplication/order belongs in the spool.
 */
export function* extractCollaborationRelations(
  input: Iterable<unknown>,
  threads: readonly CollaborationRelationThread[],
): Generator<CollaborationRelation> {
  const byThread = new Map<string, CollaborationRelationThread>();
  for (const source of threads) {
    if (byThread.has(source.thread_id))
      throw Error("ambiguous native collaboration relation thread");
    byThread.set(source.thread_id, source);
  }
  for (const value of input) {
    if (!value || typeof value !== "object")
      throw Error("invalid relation chat row");
    const row = value as Record<string, any>;
    if (row.event !== "chat") continue;
    const source = byThread.get(row.thread_id);
    if (!source)
      throw Error("relation message has no native thread provenance");
    if (typeof row.message_id !== "string" || !row.message_id.trim())
      throw Error("relation source needs durable message identities");
    if (typeof row.sender_id === "string" && UUID.test(row.sender_id)) {
      yield validateCollaborationRelation({
        kind: "participant",
        source,
        account_id: row.sender_id,
      });
    }
    // Chat edits are newest first. Unlike notification targets, graph edges track
    // the current authored message, not superseded versions in edit history.
    const content = row.history?.[0]?.content;
    if (typeof content !== "string")
      throw Error("relation message lacks current authored content");
    const seen = new Set<string>();
    for (const reference of collaborationMessageReferences(content)) {
      const relation = validateCollaborationRelation({
        kind: "reference",
        source,
        message_id: row.message_id,
        reference,
      });
      const key = collaborationRelationKey(relation);
      if (seen.has(key)) continue;
      seen.add(key);
      yield relation;
    }
  }
}
