/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Sagebrush's check of a board submission (web/board-host-protocol.md,
// "Checking a submission"), so that every host checks the same way:
// @sagemathinc/sagebrush-board/submission, pinned exactly (package.json) to
// the release that pairs with the `sagebrush` command line the skill pins
// (0.2.0 with sagebrush 0.5.0). The answers and notes it returns are only
// those the posted board asks for, checked against it.

export {
  checkSubmission,
  type Checked,
  type Posted,
  type Submission,
} from "@sagemathinc/sagebrush-board/submission";
