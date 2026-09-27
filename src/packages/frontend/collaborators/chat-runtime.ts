/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { ChatActions } from "@cocalc/frontend/chat/actions";

/** Wait for the selected host-backed chat, releasing listeners on cancellation. */
export function waitForCollaborationChat(
  actions: ChatActions,
  signal: AbortSignal,
): Promise<void> {
  const db = actions.syncdb;
  if (signal.aborted)
    return Promise.reject(Error("Conversation opening cancelled"));
  if (!db) return Promise.reject(Error("Chat synchronization is unavailable"));
  if (db.get_state() === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      db.removeListener("ready", ready);
      db.removeListener("error", error);
      db.removeListener("close", close);
      signal.removeEventListener("abort", close);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const error = (err: unknown) => {
      cleanup();
      reject(err);
    };
    const close = () => error(Error("Conversation opening cancelled"));
    const timer = setTimeout(
      () =>
        error(
          Error("Opening this conversation timed out. Retry to reconnect."),
        ),
      60_000,
    );
    db.once("ready", ready);
    db.once("error", error);
    db.once("close", close);
    signal.addEventListener("abort", close, { once: true });
  });
}
