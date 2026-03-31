/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const handlersByProjectId = new Map<string, Set<() => void>>();

export function registerProjectFilesystemChangeHandler({
  project_id,
  handler,
}: {
  project_id: string;
  handler: (() => void) | null | undefined;
}): () => void {
  if (!project_id || !handler) {
    return () => {};
  }
  let handlers = handlersByProjectId.get(project_id);
  if (!handlers) {
    handlers = new Set();
    handlersByProjectId.set(project_id, handlers);
  }
  handlers.add(handler);
  return () => {
    const current = handlersByProjectId.get(project_id);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      handlersByProjectId.delete(project_id);
    }
  };
}

export function notifyProjectFilesystemChange(project_id?: string): void {
  if (!project_id) return;
  const handlers = handlersByProjectId.get(project_id);
  if (!handlers?.size) return;
  for (const handler of handlers) {
    handler();
  }
}
