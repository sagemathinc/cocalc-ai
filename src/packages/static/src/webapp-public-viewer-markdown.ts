/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import "@cocalc/frontend/editors/slate/elements/elements.css";
import { init } from "@cocalc/frontend/public-viewer/bootstrap-markdown";
import { finishedLoading, startedUp } from "./webapp-error";

finishedLoading();
init();
startedUp();
