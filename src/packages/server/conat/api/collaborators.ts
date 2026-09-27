/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { collaboratorsApi } from "@cocalc/server/collaborators/api";
export const {
  check,
  relocateSource,
  markRoomInitialized,
  listPeople,
  listProjects,
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
