import type { ArtifactPublication } from "@cocalc/chat";
import type { ChatActions } from "./actions";

export function openArtifact(
  actions: ChatActions,
  publication: ArtifactPublication,
  version?: string,
) {
  const frames = actions.frameTreeActions;
  if (!frames || !actions.frameId) return;
  const ids = frames.get_frame_ids_in_order();
  const existing = ids.find(
    (id) =>
      frames._get_frame_data(id, "artifact") === publication.artifact_id &&
      frames._get_frame_data(id, "thread") === publication.thread_id &&
      frames._get_frame_data(id, "origin") === actions.frameId &&
      frames._get_frame_data(id, "version") === version,
  );
  if (existing) {
    frames.set_active_id(existing);
    if (window.innerWidth < 768) frames.set_frame_full(existing);
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
    "data-tabLabel":
      publication.snapshot.title + (version ? " (published)" : ""),
    ...(version === undefined ? {} : { "data-version": version }),
  });
  if (opened && workbench) frames.move_frame(opened, workbench, "tab");
  if (opened && window.innerWidth < 768) frames.set_frame_full(opened);
}
