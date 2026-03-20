/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import "@cocalc/frontend/editors/slate/elements/elements.css";
import { init } from "@cocalc/frontend/public-viewer/bootstrap";
import { startedUp } from "./webapp-error";

// Keep the public viewer entry minimal. The load chunk already installs the
// crash banner and startup error handler, so pulling in the main app's legacy
// jquery/bootstrap/xterm stack here only bloats the bundle.
init();
startedUp();
