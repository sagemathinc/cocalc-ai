/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// One board's answers channel (Sagebrush's web/board-host-protocol.md, "The
// channel" and "Once"). The card makes one for each frame element it grants a
// port to. Each channel has its own board, pending ids and taken ids, so a
// handler still running when a new board replaces the channel only touches
// its own, and its reply goes to a closed port.

import {
  checkSubmission,
  type Posted,
  type Submission,
} from "./board-answers-check";

/** The most ids one channel keeps; submissions past that are refused. */
export const MAX_IDS_PER_CHANNEL = 100;

/** A refusal in CoCalc's own words, shown to the user as it is. */
export class BoardAnswersRefusal extends Error {}

/** Resolves once the submission was saved durably as the agent's guidance
 * or turn; the submission id is its idempotency key. Throws
 * BoardAnswersRefusal on a definite failure. */
export type DeliverBoardAnswers = (
  submission: Submission,
  info: { stale: boolean },
) => Promise<void>;

interface PortLike {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

const MAX_MESSAGE = 500;

function ownWords(err: unknown): string {
  // Never an exception's text as it is, except our own refusals.
  if (err instanceof BoardAnswersRefusal) {
    return `${err.message}`.slice(0, MAX_MESSAGE);
  }
  return "Not sent: CoCalc could not save your answers. Try again.";
}

export function openAnswersChannel({
  port,
  posted,
  deliver,
  isCurrentRevision,
}: {
  port: PortLike;
  /** The board posted on this channel: one object for its lifetime. */
  posted: Posted;
  deliver: DeliverBoardAnswers;
  isCurrentRevision: (revision: string | null) => boolean;
}): { close: () => void } {
  const taken = new Set<string>();
  const pending = new Set<string>();
  let closed = false;
  const say = (
    sagebrush: "received" | "refused",
    id: string,
    message?: string,
  ) => {
    if (closed) return;
    port.postMessage({
      sagebrush,
      version: 1,
      id,
      ...(message != null ? { message: message.slice(0, MAX_MESSAGE) } : {}),
    });
  };
  port.onmessage = (event: MessageEvent) => {
    if (closed) return;
    const checked = checkSubmission(posted, event.data);
    if (!checked.ok) {
      if (checked.id) say("refused", checked.id, checked.message);
      return;
    }
    const { submission } = checked;
    const id = submission.id;
    if (taken.has(id)) return say("received", id);
    if (pending.has(id)) return; // the first one's outcome answers both
    if (taken.size + pending.size >= MAX_IDS_PER_CHANNEL) {
      return say(
        "refused",
        id,
        "Too many submissions from this board. Refresh it to go on.",
      );
    }
    pending.add(id); // before anything asynchronous
    void (async () => {
      try {
        await deliver(submission, {
          stale: !isCurrentRevision(posted.revision ?? null),
        });
        taken.add(id);
        say("received", id);
      } catch (err) {
        say("refused", id, ownWords(err));
      } finally {
        pending.delete(id);
      }
    })();
  };
  return {
    close: () => {
      closed = true;
      port.onmessage = null;
      port.close();
    },
  };
}
