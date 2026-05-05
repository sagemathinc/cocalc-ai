/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { init } from "@cocalc/frontend/public/bootstrap";
import { finishedLoading, startedUp } from "./webapp-error";

finishedLoading();
void init().finally(() => {
  startedUp();
});
