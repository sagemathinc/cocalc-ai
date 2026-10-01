/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  transaction,
  uuid,
  entryKey,
  validateTarget,
} from "./collaborators-common";
import { retainNotificationSubscriptions } from "./collaborators-subscription-store";
import { assertCollaborationOwnerAuthority } from "./collaborators-owner";
import type { CollaborationOwnerAuthority } from "./collaborators-owner";

/** Register before a home accepts Follow. This is a durable routing hint, not
 * personal state or a grant: the home still decides Follow/mute at delivery.
 * Hints are monotonic so an old unfollow/retry cannot erase a newer Follow.
 * Former followers can incur a suppressed delivery; unrelated project members
 * incur none. Membership cutovers and current authorization remain mandatory.
 */
export async function registerCollaborationNotificationSubscription(
  input: { project_id: string; account_id: string; thread_id: string },
  authority: CollaborationOwnerAuthority,
) {
  uuid(input.account_id, "subscriber");
  validateTarget({
    project_id: input.project_id,
    kind: "conversation",
    resource_id: input.thread_id,
  });
  input = {
    ...input,
    project_id: input.project_id.toLowerCase(),
    account_id: input.account_id.toLowerCase(),
  };
  const key = entryKey({
    project_id: input.project_id,
    kind: "conversation",
    resource_id: input.thread_id,
  });
  await transaction(async (db) => {
    await assertCollaborationOwnerAuthority(db, input.project_id, authority);
    const project = (
      await db.query("SELECT users,deleted FROM projects WHERE project_id=$1", [
        input.project_id,
      ])
    ).rows[0];
    if (
      project.deleted ||
      !["owner", "collaborator"].includes(
        project.users?.[input.account_id]?.group,
      )
    )
      throw Error("notification subscription access denied");
    const resource = await db.query(
      "SELECT 1 FROM collaboration_catalog WHERE project_id=$1 AND entry_key=$2 AND kind='conversation' AND deleted_at IS NULL",
      [input.project_id, key],
    );
    if (!resource.rows.length) throw Error("conversation unavailable");
    await retainNotificationSubscriptions(db, input.project_id, [
      {
        entry_key: key,
        account_id: input.account_id,
      },
    ]);
  });
}
