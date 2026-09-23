/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import {
  ARTIFACT_CATALOG_MAX_ITEMS,
  type ArtifactCatalogItem,
} from "@cocalc/util/artifact-catalog";
import { validateArtifact, validateArtifactPublication } from "./artifacts";
import type { ArtifactRecord, ArtifactPublication } from "./artifacts";

/**
 * Extract only discoverable, current artifacts from one complete document.
 * Invalid artifact records fail the snapshot, rather than silently turning
 * corruption into mass deletion. Unrelated message content is never copied.
 */
export function extractArtifactCatalog(
  rows: Iterable<unknown>,
): ArtifactCatalogItem[] {
  const current = new Map<string, ArtifactRecord>();
  const publications = new Map<
    string,
    { first: number; latest: ArtifactPublication }
  >();
  const key = (row: { thread_id: string; artifact_id: string }) =>
    JSON.stringify([row.thread_id, row.artifact_id]);
  for (const input of rows) {
    const event = (input as any)?.event;
    if (event === "chat-artifact") {
      const row = validateArtifact(input);
      if (current.has(key(row)))
        throw Error("duplicate current artifact record");
      current.set(key(row), row);
    } else if (event === "chat-artifact-publication") {
      const row = validateArtifactPublication(input);
      const time = Date.parse(row.published_at ?? "");
      if (!Number.isFinite(time) || time < 0)
        throw Error("artifact publication lacks a creation time");
      const previous = publications.get(key(row));
      publications.set(key(row), {
        first: Math.min(previous?.first ?? time, time),
        latest:
          previous &&
          (Date.parse(previous.latest.published_at!) > time ||
            (Date.parse(previous.latest.published_at!) === time &&
              previous.latest.operation_id > row.operation_id))
            ? previous.latest
            : row,
      });
    }
    if (
      current.size > ARTIFACT_CATALOG_MAX_ITEMS ||
      publications.size > ARTIFACT_CATALOG_MAX_ITEMS
    ) {
      throw Error("artifact catalog source exceeds item capacity");
    }
  }
  const items: ArtifactCatalogItem[] = [];
  for (const [identity, row] of current) {
    const publication = publications.get(identity);
    if (!publication) continue;
    const appearance: ArtifactCatalogItem["appearance"] = {};
    for (const field of [
      "color",
      "accent_color",
      "icon",
      "image_blob",
    ] as const) {
      if (row.theme?.[field]) appearance[field] = row.theme[field];
    }
    const target = row.file
      ? { path: row.file.path }
      : row.commit
        ? { path: row.commit.path, sha: row.commit.sha }
        : row.github_pr
          ? { repository: row.github_pr.repository }
          : undefined;
    items.push({
      thread_id: row.thread_id,
      artifact_id: row.artifact_id,
      kind: row.kind,
      title: (row.theme?.title || row.title).slice(0, 512),
      description: (row.theme?.description ?? "").slice(0, 2048),
      created_at: publication.first,
      publication: {
        operation_id: publication.latest.operation_id,
        message_id: publication.latest.message_id,
      },
      ...(Object.keys(appearance).length ? { appearance } : {}),
      ...(target ? { target } : {}),
    });
  }
  return items;
}
