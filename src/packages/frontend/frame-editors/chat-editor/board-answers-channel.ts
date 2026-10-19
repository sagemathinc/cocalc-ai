/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// One board's answers channel (Sagebrush's web/board-host-protocol.md, "The
// channel" and "Once"). The card makes one for each frame element it grants a
// port to. Each channel has its own board, pending ids and taken ids, so a
// handler still running when a new board replaces the channel only touches
// its own, and its reply goes to a closed port.
//
// A "decide" request (the protocol's "Deciding") is not a submission: it is
// never checked as one, never delivered, and starts no turn. It goes only
// to `decide` (the hub's system.boardDecide, which checks it against the
// board posted on this channel), and the frame gets back only "decided"
// with an option name or null, or "refused". Per channel: one in flight and
// at most MAX_DECIDES_PER_CHANNEL; the hub limits per user and board, and in
// total.

import {
  checkSubmission,
  type Posted,
  type Submission,
} from "./board-answers-check";

/** The most ids one channel keeps; submissions past that are refused. */
export const MAX_IDS_PER_CHANNEL = 100;

/** The most decide requests one channel sends; then the board must be
 * reloaded (a new channel). */
export const MAX_DECIDES_PER_CHANNEL = 30;

/** A refusal in CoCalc's own words, shown to the user as it is. */
export class BoardAnswersRefusal extends Error {}

/** Asks which of the posted question's options the reader's words show:
 * an option name, or null for none. Throws BoardAnswersRefusal on a
 * definite refusal. */
export type DecideOnBoard = (message: unknown) => Promise<string | null>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OPTION_NAME = 80;

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
  decide,
}: {
  port: PortLike;
  /** The board posted on this channel: one object for its lifetime. */
  posted: Posted;
  deliver: DeliverBoardAnswers;
  isCurrentRevision: (revision: string | null) => boolean;
  /** Given only where this CoCalc checks answers with a model. */
  decide?: DecideOnBoard;
}): { close: () => void } {
  const taken = new Set<string>();
  const pending = new Set<string>();
  let deciding = false;
  let decides = 0;
  let closed = false;
  const onDecide = (data: { id?: unknown }) => {
    const id = data.id;
    if (typeof id !== "string" || !UUID.test(id)) return;
    const refuse = (message: string) => say("refused", id, message);
    if (!decide) {
      return refuse("Answers aren't checked by a model on this CoCalc.");
    }
    if (deciding) {
      return refuse("Still checking your last answer. Wait for it.");
    }
    if (decides >= MAX_DECIDES_PER_CHANNEL) {
      return refuse(
        "Too many answers checked on this board. Reload it to go on.",
      );
    }
    deciding = true; // before anything asynchronous
    decides += 1;
    void (async () => {
      try {
        const option = await decide(data);
        if (
          option !== null &&
          (typeof option !== "string" ||
            option.length === 0 ||
            option.length > MAX_OPTION_NAME)
        ) {
          throw new Error("bad option");
        }
        if (!closed) {
          port.postMessage({ sagebrush: "decided", version: 1, id, option });
        }
      } catch (err) {
        refuse(
          err instanceof BoardAnswersRefusal
            ? `${err.message}`.slice(0, MAX_MESSAGE)
            : "CoCalc could not check your answer. Try again.",
        );
      } finally {
        deciding = false;
      }
    })();
  };
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
    const data = event.data;
    if (
      data != null &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      data.sagebrush === "decide"
    ) {
      return onDecide(data);
    }
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
