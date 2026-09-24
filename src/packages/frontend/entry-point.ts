/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
 * Global app initialization
 */

import debug from "debug";
debug.log = console.log.bind(console); // see https://github.com/debug-js/debug#output-streams

import { COCALC_MINIMAL } from "./fullscreen";

// Load/initialize Redux-based react functionality
import { redux } from "./app-framework";

import "./launch/actions";

// Initialize app stores, actions, etc.
import { init as initAccount } from "./account";
import { init as initApp } from "./app/init";
import { init as initProjects } from "./projects";
import { init as initFileUse } from "./file-use/init";
import { init as initWebHooks } from "./webapp-hooks";
// only enable iframe comms in minimal kiosk mode
import { init as initIframeComm } from "./iframe-communication";
import { init as initCrashBanner } from "./crash-banner";
import { init as initCustomize } from "./customize";

// Should be loaded last
import { init as initLast } from "./last";

import { render } from "./app/render";
import { markAppBootstrapPhase } from "./app/bootstrap-ux-latency";
import { installPostSurfaceJqueryPlugins } from "./jquery-plugins/ensure-init";

function runInitializer(name: string, initializer: () => void): void {
  markAppBootstrapPhase(`${name}_started`);
  try {
    initializer();
    markAppBootstrapPhase(`${name}_finished`);
  } catch (err) {
    markAppBootstrapPhase(`${name}_failed`);
    throw err;
  }
}

export async function init() {
  markAppBootstrapPhase("global_initializers_started");
  installPostSurfaceJqueryPlugins();
  runInitializer("account", () => initAccount(redux));
  runInitializer("app", initApp);
  runInitializer("projects", initProjects);
  runInitializer("file_use", initFileUse);
  runInitializer("webapp_hooks", initWebHooks);
  runInitializer("customize", () => void initCustomize());
  if (COCALC_MINIMAL) {
    runInitializer("iframe_communication", initIframeComm);
  }
  window.addEventListener(
    "beforeunload",
    redux.getActions("page").check_unload,
  );
  runInitializer("last", initLast);
  markAppBootstrapPhase("global_initializers_finished");
  try {
    await render();
  } finally {
    // don't insert the crash banner until the main app has rendered,
    // or user would see the banner for a moment.
    initCrashBanner();
  }
}
