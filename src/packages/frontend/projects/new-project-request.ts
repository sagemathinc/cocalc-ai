/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { pendingRequest } from "@cocalc/frontend/app/pending-request";

// "+ New Project" outside the Projects page opens that page's create dialog.
const newProject = pendingRequest("new-project");
export const requestNewProject = newProject.request;
export const onNewProjectRequest = newProject.on;
