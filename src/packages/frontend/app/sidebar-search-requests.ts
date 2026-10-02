/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { pendingRequest } from "./pending-request";

// The sidebar's "Search Library" / "Search People" open those pages' own
// searches (artifact metadata; conversation messages).
export const librarySearchRequest = pendingRequest("library-search");
export const peopleSearchRequest = pendingRequest("people-search");
// "+ New Conversation" in the People sidebar.
export const newConversationRequest = pendingRequest("new-conversation");
