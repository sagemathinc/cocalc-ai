/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { path_split } from "@cocalc/util/misc";
import { readArtifact, type ArtifactPublication } from "@cocalc/chat";
import type { ChatActions } from "./actions";

export interface ProjectFileResult {
  kind: "file";
  path: string;
  title?: string;
  line?: number;
  revision?: string;
  threadId?: string;
}

export interface ArtifactResult {
  kind: "artifact";
  publication: ArtifactPublication;
  version?: string;
  source?: ArtifactSource;
}

export interface ArtifactSource {
  project_id: string;
  path: string;
  agent_id?: string;
}

export type ChatResult = ProjectFileResult | ArtifactResult;

export function openResult(actions: ChatActions, result: ChatResult) {
  if (result.kind === "artifact") {
    openArtifactResult(actions, result);
    return;
  }
  openProjectFileResult(actions, result);
}

function openArtifactResult(actions: ChatActions, result: ArtifactResult) {
  const frames = actions.frameTreeActions;
  if (!frames || !actions.frameId) return;
  const { publication, version, source } = result;
  const project = actions.store?.get("project_id");
  const path = actions.store?.get("path");
  const ids = frames.get_frame_ids_in_order();
  const existing = ids.find(
    (id) =>
      frames._get_frame_data(id, "artifact") === publication.artifact_id &&
      frames._get_frame_data(id, "thread") === publication.thread_id &&
      (frames._get_frame_data(id, "sourceProject") ?? project) ===
        (source?.project_id ?? project) &&
      (frames._get_frame_data(id, "sourcePath") ?? path) ===
        (source?.path ?? path) &&
      frames._get_frame_data(id, "origin") === actions.frameId &&
      frames._get_frame_data(id, "version") === version,
  );
  if (existing) {
    // A shared chat can host several agents. Reusing a tab after changing
    // threads must also update whether feedback is local or source-scoped.
    frames.set_frame_data?.({
      id: existing,
      sourceProject: source?.project_id ?? null,
      sourcePath: source?.path ?? null,
      sourceAgent: source?.agent_id ?? null,
    });
    focusResultFrame(frames, existing);
    return;
  }
  const workbench = ids.find(
    (id) => frames._get_frame_type?.(id) === "workbench",
  );
  const opened = frames.split_frame("col", actions.frameId, "workbench", {
    "data-artifact": publication.artifact_id,
    "data-thread": publication.thread_id,
    "data-origin": actions.frameId,
    "data-publication": publication.operation_id,
    ...(source
      ? {
          "data-sourceProject": source.project_id,
          "data-sourcePath": source.path,
          "data-sourceAgent": source.agent_id,
        }
      : {}),
    "data-tabLabel":
      publication.snapshot.title + (version ? " (message version)" : ""),
    ...(version === undefined ? {} : { "data-version": version }),
  });
  if (opened && workbench) frames.move_frame(opened, workbench, "tab");
  if (opened && window.innerWidth < 768) frames.set_frame_full(opened);
}

function focusResultFrame(frames: any, id: string) {
  frames.set_active_id(id);
  if (window.innerWidth < 768) frames.set_frame_full(id);
}

/** Open a saved project file in the chat Workbench without publishing it. */
export function openProjectFileResult(
  actions: ChatActions,
  result: ProjectFileResult,
) {
  const frames = actions.frameTreeActions;
  if (!frames || !actions.frameId || !result.path) return;
  const ids = frames.get_frame_ids_in_order();
  const existing = ids.find((id) => {
    // A same-named file in a foreign project is not this project's file.
    if (
      frames._get_frame_data(id, "sourceProject") &&
      (frames._get_frame_data(id, "sourceProject") !==
        actions.store?.get("project_id") ||
        frames._get_frame_data(id, "sourcePath") !== actions.store?.get("path"))
    )
      return false;
    if (
      frames._get_frame_type?.(id) !== "workbench" ||
      frames._get_frame_data(id, "origin") !== actions.frameId
    )
      return false;
    if (frames._get_frame_data(id, "path") === result.path) {
      return frames._get_frame_data(id, "revision") === result.revision;
    }
    const artifactId = frames._get_frame_data(id, "artifact");
    const threadId = frames._get_frame_data(id, "thread");
    if (!artifactId || !threadId || !actions.syncdb) return false;
    if (frames._get_frame_data(id, "version") !== result.revision) return false;
    try {
      return (
        readArtifact(actions.syncdb, {
          artifact_id: artifactId,
          thread_id: threadId,
        }).artifact.file?.path === result.path
      );
    } catch {
      return false;
    }
  });
  if (existing) {
    focusResultFrame(frames, existing);
    return;
  }
  const workbench = ids.find(
    (id) => frames._get_frame_type?.(id) === "workbench",
  );
  const opened = frames.split_frame("col", actions.frameId, "workbench", {
    "data-path": result.path,
    "data-line": result.line,
    "data-revision": result.revision,
    "data-thread": result.threadId,
    "data-origin": actions.frameId,
    "data-tabLabel":
      result.title?.trim() || path_split(result.path).tail || result.path,
  });
  if (opened && workbench) frames.move_frame(opened, workbench, "tab");
  if (opened && window.innerWidth < 768) frames.set_frame_full(opened);
}
