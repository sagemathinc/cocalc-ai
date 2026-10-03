/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { pendingRequest } from "./pending-request";

// "+ New Conversation" in the People sidebar.
export const newConversationRequest = pendingRequest("new-conversation");
// From Quick Navigation: open the New Artifact dialog; show or hide the
// workspace sidebar.
export const newArtifactRequest = pendingRequest("new-artifact");
export const toggleSidebarRequest = pendingRequest("toggle-sidebar");
