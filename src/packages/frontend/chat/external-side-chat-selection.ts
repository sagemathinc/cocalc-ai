import {
  local_storage,
  local_storage_delete,
} from "@cocalc/frontend/editor-local-storage";
import { original_path } from "@cocalc/util/misc";

const EXTERNAL_SIDE_CHAT_SELECTED_THREAD_KEY = "selectedThreadKey";
const EXTERNAL_SIDE_CHAT_FLAG = "data-externalSideChat";

function normalizeSelectedThreadKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function getExternalSideChatDesc(project_id: string, path: string) {
  const selectedThreadKey = normalizeSelectedThreadKey(
    local_storage(
      project_id,
      original_path(path),
      EXTERNAL_SIDE_CHAT_SELECTED_THREAD_KEY,
    ),
  );
  const desc: Record<string, string | boolean> = {
    [EXTERNAL_SIDE_CHAT_FLAG]: true,
  };
  if (selectedThreadKey) {
    desc["data-selectedThreadKey"] = selectedThreadKey;
  }
  return desc;
}

export function persistExternalSideChatSelectedThreadKey({
  project_id,
  path,
  selectedThreadKey,
}: {
  project_id: string;
  path: string;
  selectedThreadKey?: string | null;
}) {
  const targetPath = original_path(path);
  const normalized = normalizeSelectedThreadKey(selectedThreadKey);
  if (normalized) {
    local_storage(
      project_id,
      targetPath,
      EXTERNAL_SIDE_CHAT_SELECTED_THREAD_KEY,
      normalized,
    );
    return;
  }
  local_storage_delete(
    project_id,
    targetPath,
    EXTERNAL_SIDE_CHAT_SELECTED_THREAD_KEY,
  );
}
