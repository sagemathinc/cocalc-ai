/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { collaboratorsApi } from "@cocalc/server/collaborators/api";
export const {
  resolveChatAlias,
  resolvePersonAlias,
  getPersonAlias,
  setPersonAlias,
  stageRelationPage,
  listParticipants,
  listReferences,
  getRoom,
  replaceRoomForHost,
  getDiscovery,
  discoveryForHost,
  reportDiscovery,
  check,
  relocateSource,
  markRoomInitialized,
  listPeople,
  listProjects,
  setProjectPinned,
  listResources,
  listProjectResources,
  checkpointPage,
  requestSource,
  getResource,
  setPersonalState,
  ensureRoom,
  roomForHost,
  registerSource,
  ingest,
} = collaboratorsApi;
export { writerState, sourcePage } from "@cocalc/server/collaborators/api";
