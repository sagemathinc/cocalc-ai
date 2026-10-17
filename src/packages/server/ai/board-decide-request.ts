/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Sagebrush's reading of a board's decide request (web/board-host-protocol.md,
// "Deciding"): the question's prompt and options come from the posted board,
// never from the message; only the reader's words do. It is
// @sagemathinc/sagebrush-board/submission, pinned exactly (package.json) to
// the release whose frame the card shows.
//
// That package is ES modules only, and this one is compiled to CommonJS, where
// `import()` would become `require()`, which its exports don't allow. So it is
// loaded with the runtime's own import(), once. If it can't be loaded, every
// request is refused: nothing is decided unchecked.

import getLogger from "@cocalc/backend/logger";
import type {
  DecideRequest,
  Deciding,
  Posted,
} from "@sagemathinc/sagebrush-board/submission";

export type { DecideRequest, Deciding, Posted };

const log = getLogger("server:ai:board-decide-request");

type Submission = typeof import("@sagemathinc/sagebrush-board/submission");

const SUBMISSION = "@sagemathinc/sagebrush-board/submission";
const nativeImport = new Function("s", "return import(s)") as (
  s: string,
) => Promise<Submission>;

let loader: () => Promise<Submission> = () => nativeImport(SUBMISSION);
let loading: Promise<Submission> | undefined;

/** For tests: how the package is loaded. */
export function setSubmissionLoaderForTests(
  load: (() => Promise<Submission>) | undefined,
): void {
  loader = load ?? (() => nativeImport(SUBMISSION));
  loading = undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function decideRequest(
  posted: Posted,
  m: unknown,
): Promise<Deciding> {
  let submission: Submission;
  try {
    submission = await (loading ??= loader());
    if (typeof submission?.decideRequest !== "function") {
      throw Error("no decideRequest");
    }
  } catch (err) {
    loading = undefined;
    log.error("could not load Sagebrush's submission check", `${err}`);
    const id = (m as { id?: unknown } | null)?.id;
    return {
      ok: false,
      ...(typeof id === "string" && UUID.test(id) ? { id } : {}),
      message: "Answers can't be checked on this CoCalc right now.",
    };
  }
  return submission.decideRequest(posted, m);
}
