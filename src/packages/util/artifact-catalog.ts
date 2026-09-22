/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** Content-free metadata. Catalog entries are locators, never authorization. */
export interface ArtifactCatalogItem {
  thread_id: string;
  artifact_id: string;
  kind: string;
  title: string;
  description: string;
  created_at: number;
  publication: { operation_id: string; message_id: string };
  appearance?: {
    color?: string;
    accent_color?: string;
    icon?: string;
    image_blob?: string;
  };
  target?: { path?: string; repository?: string; sha?: string };
}

export interface ArtifactCatalogSource {
  project_id: string;
  chat_path: string;
}

/** A complete source snapshot; omission is a removal, not an incomplete page. */
export interface ArtifactCatalogSnapshot extends ArtifactCatalogSource {
  schema_version: 1;
  /** Assigned/fenced by the project owner, not chosen by an untrusted writer. */
  epoch: string;
  sequence: number;
  items: ArtifactCatalogItem[];
}

export const ARTIFACT_CATALOG_MAX_ITEMS = 5000;
export const ARTIFACT_CATALOG_MAX_BYTES = 2 * 1024 * 1024;

export function artifactCatalogKey(
  source: ArtifactCatalogSource,
  item: Pick<ArtifactCatalogItem, "thread_id" | "artifact_id">,
): string {
  return JSON.stringify([
    source.project_id,
    source.chat_path,
    item.thread_id,
    item.artifact_id,
  ]);
}

function text(value: unknown, max: number, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.length) ||
    value.length > max ||
    value.includes("\0")
  ) {
    throw Error("invalid artifact catalog string");
  }
  return value;
}

export function validateArtifactCatalogSnapshot(
  input: ArtifactCatalogSnapshot,
): ArtifactCatalogSnapshot {
  if (
    input?.schema_version !== 1 ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !Array.isArray(input.items) ||
    input.items.length > ARTIFACT_CATALOG_MAX_ITEMS
  ) {
    throw Error("invalid artifact catalog snapshot");
  }
  const project_id = text(input.project_id, 36);
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(project_id)) {
    throw Error("invalid artifact catalog project");
  }
  const chat_path = text(input.chat_path, 4096);
  if (
    !chat_path.startsWith("/") ||
    !chat_path.endsWith(".chat") ||
    chat_path
      .split("/")
      .some((part, i) => i > 0 && (!part || part === "." || part === ".."))
  ) {
    throw Error("artifact catalog requires a canonical absolute chat path");
  }
  const seen = new Set<string>();
  const items = input.items.map((item): ArtifactCatalogItem => {
    const thread_id = text(item.thread_id, 200);
    const artifact_id = text(item.artifact_id, 200);
    const key = JSON.stringify([thread_id, artifact_id]);
    if (seen.has(key)) throw Error("duplicate artifact catalog identity");
    seen.add(key);
    if (
      !Number.isSafeInteger(item.created_at) ||
      item.created_at < 0 ||
      item.created_at > 8640000000000000
    ) {
      throw Error("invalid artifact catalog creation time");
    }
    const appearance: ArtifactCatalogItem["appearance"] = {};
    for (const field of [
      "color",
      "accent_color",
      "icon",
      "image_blob",
    ] as const) {
      if (item.appearance?.[field] !== undefined) {
        appearance[field] = text(item.appearance[field], 256);
      }
    }
    const target: ArtifactCatalogItem["target"] = {};
    for (const field of ["path", "repository", "sha"] as const) {
      if (item.target?.[field] !== undefined) {
        target[field] = text(item.target[field], field === "path" ? 4096 : 256);
      }
    }
    return {
      thread_id,
      artifact_id,
      kind: text(item.kind, 64),
      title: text(item.title, 512, true),
      description: text(item.description, 2048, true),
      created_at: item.created_at,
      publication: {
        operation_id: text(item.publication?.operation_id, 200),
        message_id: text(item.publication?.message_id, 200),
      },
      ...(Object.keys(appearance).length ? { appearance } : {}),
      ...(Object.keys(target).length ? { target } : {}),
    };
  });
  // Canonical order makes duplicate delivery checks independent of input order.
  items.sort((a, b) => {
    const left = JSON.stringify([a.thread_id, a.artifact_id]);
    const right = JSON.stringify([b.thread_id, b.artifact_id]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const snapshot: ArtifactCatalogSnapshot = {
    schema_version: 1,
    project_id,
    chat_path,
    epoch: text(input.epoch, 200),
    sequence: input.sequence,
    items,
  };
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).length >
    ARTIFACT_CATALOG_MAX_BYTES
  ) {
    throw Error("artifact catalog snapshot is too large");
  }
  return snapshot;
}
