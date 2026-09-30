/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// Registers the local Hub API dispatcher without starting its subscriptions.
import "@cocalc/server/conat/api";
import { loadConatConfiguration } from "@cocalc/server/conat/configuration";
import { initVmPersonalFundingApprovalHandler } from "@cocalc/server/compute/funding/vm-personal";
import { initCourseFundingApprovalService } from "@cocalc/server/compute/funding/approval-startup";
import { enableDbAccountRowFeedPublishing } from "@cocalc/server/account/account-row-feed";
import { enableDbCollaboratorAccountFeedPublishing } from "@cocalc/server/account/collaborator-feed";
import { enableDbProjectAccountFeedPublishing } from "@cocalc/server/account/project-feed";
import { startBillingAuthorityService } from "./service";

export async function startStandaloneBillingExecutor(): Promise<void> {
  if (process.env.COCALC_DB === "pglite") {
    throw Error(
      "The separate billing executor requires shared PostgreSQL, not process-local PGlite",
    );
  }
  await loadConatConfiguration();
  initVmPersonalFundingApprovalHandler();
  await initCourseFundingApprovalService({ listen: false });
  enableDbAccountRowFeedPublishing();
  enableDbCollaboratorAccountFeedPublishing();
  enableDbProjectAccountFeedPublishing();
  startBillingAuthorityService({ executor: true });
}
