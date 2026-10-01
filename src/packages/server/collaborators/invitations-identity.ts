/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { v5 as uuidv5 } from "uuid";

/** Access IDs use the child ID; permission-free intent needs a distinct identity. */
export function peopleCollaborationInvitationId(
  operation_id: string,
  child_operation_id: string,
): string {
  return uuidv5(
    `people-collaboration-invitation:v1:${operation_id}:${child_operation_id}`,
    uuidv5.URL,
  );
}
