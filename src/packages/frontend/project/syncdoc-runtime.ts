/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { SyncDoc } from "@cocalc/sync/editor/generic/sync-doc";

type CloseableSyncDoc = {
  project_id?: string;
  close?: () => Promise<void> | void;
  once?: (event: string, cb: () => void) => void;
};

const projectSyncDocs = new Map<string, Set<CloseableSyncDoc>>();
let trackingInstalled = false;

function removeProjectSyncDoc(doc: CloseableSyncDoc): void {
  const project_id = `${doc?.project_id ?? ""}`.trim();
  if (!project_id) {
    return;
  }
  const docs = projectSyncDocs.get(project_id);
  if (docs == null) {
    return;
  }
  docs.delete(doc);
  if (docs.size === 0) {
    projectSyncDocs.delete(project_id);
  }
}

export function trackProjectSyncDoc(doc: CloseableSyncDoc): void {
  const project_id = `${doc?.project_id ?? ""}`.trim();
  if (!project_id) {
    return;
  }
  let docs = projectSyncDocs.get(project_id);
  if (docs == null) {
    docs = new Set();
    projectSyncDocs.set(project_id, docs);
  }
  if (docs.has(doc)) {
    return;
  }
  docs.add(doc);
  doc.once?.("close", () => removeProjectSyncDoc(doc));
  doc.once?.("closed", () => removeProjectSyncDoc(doc));
}

export function ensureProjectSyncDocTracking(): void {
  if (trackingInstalled) {
    return;
  }
  trackingInstalled = true;
  SyncDoc.events.on("new", trackProjectSyncDoc);
}

export async function closeProjectSyncDocs(project_id: string): Promise<void> {
  ensureProjectSyncDocTracking();
  const docs = projectSyncDocs.get(project_id);
  if (docs == null || docs.size === 0) {
    return;
  }
  const closing = [...docs];
  await Promise.allSettled(closing.map(async (doc) => await doc.close?.()));
  for (const doc of closing) {
    removeProjectSyncDoc(doc);
  }
}

export function resetTrackedProjectSyncDocsForTests(): void {
  projectSyncDocs.clear();
  if (trackingInstalled) {
    SyncDoc.events.removeListener("new", trackProjectSyncDoc);
    trackingInstalled = false;
  }
}
