/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { activate as initAutorenice } from "./autorenice";
import { getOptions } from "./init-program";
import * as initScript from "./init-script";
import { getLogger } from "./logger";
import * as projectSetup from "./project-setup";
import * as sshd from "./sshd";

export default async function init() {
  const logger = getLogger("init-project-runtime");
  const options = getOptions();
  logger.info("initializing project runtime");

  if (process.env.COCALC_PROJECT_AUTORENICE != null) {
    initAutorenice();
  }

  projectSetup.configure();
  const envVars = projectSetup.set_extra_env();

  if (options.sshd) {
    await sshd.init(envVars);
  }

  await initScript.run();
}
