export const THREAD_SEARCH_EVENT = "cocalc-thread-search";
export function requestThreadSearch(
  projectId: string,
  path: string,
  threadId: string,
) {
  window.dispatchEvent(
    new CustomEvent(THREAD_SEARCH_EVENT, {
      detail: { projectId, path, threadId },
    }),
  );
}
