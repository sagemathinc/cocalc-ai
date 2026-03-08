import type { UndoMode } from "./types";

interface ResolveUndoHandlerOptions {
  mode?: UndoMode;
  handler?: (() => void) | undefined;
}

export function resolveUndoHandler({
  mode = "auto",
  handler,
}: ResolveUndoHandlerOptions): (() => void) | undefined {
  if (mode === "local") {
    return undefined;
  }
  if (mode === "external") {
    return handler;
  }
  return handler;
}
