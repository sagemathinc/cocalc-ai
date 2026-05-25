/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { finishedLoading, startedUp } from "./webapp-error";

(globalThis as any).__cocalc_public_app = true;

finishedLoading();
void import("@cocalc/frontend/public/bootstrap")
  .then(({ init }) => init())
  .finally(() => {
    startedUp();
  });
