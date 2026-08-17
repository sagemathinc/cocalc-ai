/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { set_account_profile_image_if_not_set } from "@cocalc/database/postgres/account/queries";
import { publishAccountRowFeedEventsBestEffort } from "@cocalc/server/account/account-row-feed";
import { publishCollaboratorAccountFeedEventsBestEffort } from "@cocalc/server/account/collaborator-feed";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";

export async function initializeAccountProfileImage({
  account_id,
  image,
}: {
  account_id: string;
  image: string;
}): Promise<boolean> {
  const profile = await withAccountRehomeWriteFence({
    account_id,
    action: "initialize account profile image",
    fn: async (db) =>
      await set_account_profile_image_if_not_set({
        db,
        account_id,
        image,
      }),
  });
  if (profile == null) return false;

  await Promise.all([
    publishAccountRowFeedEventsBestEffort({
      account_id,
      patch: { profile },
      reason: "user_query_set",
    }),
    publishCollaboratorAccountFeedEventsBestEffort({
      collaborator_account_id: account_id,
    }),
  ]);
  return true;
}
