export const THREAD_SEARCH_EVENT = "cocalc-thread-search";
export function requestThreadSearch(
  projectId: string,
  path: string,
  threadId: string,
  mode: "search" | "history" | "maintenance" = "search",
) {
  window.dispatchEvent(
    new CustomEvent(THREAD_SEARCH_EVENT, {
      detail: { projectId, path, threadId, mode },
    }),
  );
}
