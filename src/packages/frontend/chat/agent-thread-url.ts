import { join } from "path";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { encode_path, isValidUUID } from "@cocalc/util/misc";

export function agentThreadUrl(
  projectId: string,
  path: string,
  threadId: string,
  origin = window.location.origin,
): string {
  // This is an application permalink, not a project-host file download URL.
  const url = new URL(
    join(appBasePath, "projects", projectId, "files", encode_path(path)),
    origin,
  );
  url.hash = `thread=${encodeURIComponent(threadId)}`;
  return url.href;
}

export function parseAgentThreadUrl(
  value: string,
  origin = window.location.origin,
) {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password)
    throw new Error(
      "Use a thread URL from this CoCalc site. Cross-site links are not supported.",
    );
  // Also accept the short file URLs copied by earlier clients, and base paths.
  const match = url.pathname.match(/\/([^/]+)\/files\/(.+)$/);
  if (!match || !isValidUUID(match[1]))
    throw new Error("Use a CoCalc chat thread URL.");
  const path = decodeURIComponent(match[2]);
  const threadId = new URLSearchParams(url.hash.slice(1)).get("thread");
  if (
    !path.endsWith(".chat") ||
    !threadId ||
    threadId.length > 200 ||
    path.includes("\0")
  )
    throw new Error(
      "The URL must select a thread in a .chat file. Use Copy thread URL in Codex settings.",
    );
  return {
    project_id: match[1],
    path: path.startsWith("/") ? path : `/${path}`,
    thread_id: threadId,
  };
}
