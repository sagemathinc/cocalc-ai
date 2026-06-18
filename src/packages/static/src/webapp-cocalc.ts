/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { cocalcStylesReady } from "./webapp-libraries";
import { init } from "@cocalc/frontend/entry-point";
import { startedUp } from "./webapp-error";

async function start() {
  await cocalcStylesReady;
  init();
  startedUp();
}

void start().catch((error) => {
  console.warn("CoCalc startup failed", error);
  setTimeout(() => {
    throw error;
  });
});
