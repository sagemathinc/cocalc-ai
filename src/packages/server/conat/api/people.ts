/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { peopleApi } from "@cocalc/server/people/api";

export const {
  listConversations,
  getConversation,
  addConversation,
  touchConversation,
  refreshConversation,
  renameConversation,
  removeConversation,
  markRead,
  listSharedWork,
  listAgents,
  listInvites,
  getAgentAccess,
  setAgentAccess,
  setAgentAppearance,
  setState,
  listStates,
  resolveAlias,
} = peopleApi;
