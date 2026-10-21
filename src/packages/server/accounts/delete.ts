import { isValidUUID } from "@cocalc/util/misc";
import getPool from "@cocalc/database/pool";
import { recordAccountRevocation } from "@cocalc/server/accounts/revocation";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import { endAllSignInSessions } from "@cocalc/server/auth/auth-sessions";
import { deleteBlobsForAccountDeletion } from "@cocalc/server/membership/blob-limits";
import { cleanupSiteLicenseAccessForAccountDeletion } from "@cocalc/server/membership/account-deletion";
import { disposeOwnedProjectsForAccountDeletion } from "@cocalc/server/projects/ownership";
import { deleteRootfsImagesForAccountDeletion } from "@cocalc/server/rootfs/catalog";
import {
  executeBillingAuthorityCommand,
  setBillingAccountFrozen,
} from "@cocalc/server/purchases/billing-authority/client";
import {
  getOAuthPurgeTargets,
  queueOAuthClientPurges,
} from "@cocalc/server/auth/oauth/purge";
import type { AccountDeletionInitiator } from "@cocalc/conat/inter-bay/api";
import {
  ensureAccountAdminAuditLogSchema,
  recordAccountAdminAuditEventInTransaction,
} from "./admin-audit";
import { deleteClusterAccountDirectoryEntry } from "./cluster-directory";
import { CLEAR_DELETED_ACCOUNT_PERSONAL_FIELDS_SQL } from "./deleted-account-retention";
import {
  dropOnHosts,
  revokeComputersForAccount,
} from "@cocalc/server/computers/computers";

export interface AccountDeletionContext {
  initiator: AccountDeletionInitiator;
  // the account that asked for the deletion: the account itself or an admin
  actor_account_id?: string | null;
}

export default async function deleteAccount(
  account_id: string,
  context: AccountDeletionContext = { initiator: "system" },
): Promise<void> {
  if (!isValidUUID(account_id)) {
    throw Error(`invalid account_id=${account_id}`);
  }

  const revokedBeforeMs = Date.now();

  // Site-license access is seed-authoritative and must be released before
  // billing is frozen, since normal membership revocation rejects frozen accounts.
  await cleanupSiteLicenseAccessForAccountDeletion({ account_id });

  // Cancel any subscriptions
  await cancelStripeEverything(account_id);

  // Invalidate all sign ins (without this user can delete account, but could
  // still be signed in). Do this before marking the account deleted;
  // account-scoped write fences intentionally stop resolving deleted accounts.
  await endAllSignInSessions(account_id);
  // Revoke host-level persistent sessions/tokens issued before this delete.
  await recordAccountRevocation(account_id, revokedBeforeMs, { banned: true });

  // Owned projects must be resolved before the account is marked deleted:
  // owner-only projects are hard-deleted, and shared projects transfer to a
  // remaining collaborator so they never become ownerless storage.
  await disposeOwnedProjectsForAccountDeletion(account_id);

  // Owned RootFS catalog entries are account-owned durable storage resources.
  // Retire them before marking the account deleted so the existing release-GC
  // blocker logic can remove artifacts that are no longer referenced.
  await deleteRootfsImagesForAccountDeletion(account_id);

  // Account-attributed blobs count against membership quota and can be costly
  // if left behind. Project-attributed blobs are handled by project hard delete.
  await deleteBlobsForAccountDeletion({ account_id });

  // Mark the account as deleted -- do this last since once done, user is locked out.
  // Any step above could fail, and user could just try again in that case.
  await markAccountDeleted(account_id, context);
  await deleteClusterAccountDirectoryEntry(account_id);
}

/*
Mark the account as deleted, thus freeing up the email address and passports
for use by another account, etc. The actual account entry remains in the
database, since it may be referred to by many other things (projects, logs,
etc.). However, the deleted field is set to true, so the account is excluded
from user search and it is not possible to sign in to this account.

The personal data in the row (names, password hash, avatar, ssh keys, LTI
identity, ...) is cleared. The former email address is kept for a limited time
to help with recovery requests and abuse, then removed by the retention loop in
deleted-account-retention.ts. An audit row records who started the deletion.
*/

export async function markAccountDeleted(
  account_id: string,
  context: AccountDeletionContext = { initiator: "system" },
): Promise<void> {
  const client_ids = await getOAuthPurgeTargets();
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT email_address FROM accounts WHERE account_id=$1",
    [account_id],
  );
  if (rows.length == 0) {
    throw Error(`no account with account_id=${account_id}`);
  }
  const email_address_before_delete = rows[0].email_address ?? "";
  await ensureAccountAdminAuditLogSchema();
  let revoked: Awaited<ReturnType<typeof revokeComputersForAccount>> = [];
  await withAccountRehomeWriteFence({
    account_id,
    action: "delete account",
    fn: async (db) => {
      // Before deleted=true, in the same transaction: every computer of the
      // account is revoked (its host drops it; its connector stops).
      revoked = await revokeComputersForAccount(db, account_id);
      await db.query(
        `UPDATE accounts SET deleted=true, email_address_before_delete=$1::TEXT, email_address=NULL, passports=NULL, ${CLEAR_DELETED_ACCOUNT_PERSONAL_FIELDS_SQL} WHERE account_id=$2::UUID`,
        [email_address_before_delete, account_id],
      );
      await recordAccountAdminAuditEventInTransaction({
        client: db,
        account_id,
        action: "account-deletion",
        actor_account_id: context.actor_account_id ?? null,
        metadata: { initiator: context.initiator },
      });
      // In the same transaction, so a deleted account always has its purge
      // requests queued, and a failed deletion queues none.
      await queueOAuthClientPurges({ db, account_id, client_ids });
    },
  });
  await dropOnHosts(revoked);
}

export async function cancelStripeEverything(
  account_id: string,
): Promise<void> {
  await setBillingAccountFrozen({
    account_id,
    frozen: true,
    cause: "deletion",
    reason: "account deletion",
  });
  await executeBillingAuthorityCommand({
    kind: "account-stripe-cleanup",
    account_id,
  });
}
