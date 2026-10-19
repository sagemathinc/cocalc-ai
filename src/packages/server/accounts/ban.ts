import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import { recordAccountRevocation } from "@cocalc/server/accounts/revocation";
import { recordAccountSecurityState } from "@cocalc/server/accounts/security-state";
import { endAllSignInSessions } from "@cocalc/server/auth/auth-sessions";
import getLogger from "@cocalc/backend/logger";
import { clearIsBannedCache } from "./is-banned";
import { stopRunningProjectsForBannedAccount } from "./stop-banned-projects";
import { ensureAccountBanTimestampSchema } from "./ban-timestamp";

const logger = getLogger("server:accounts:ban");

export async function banUser(account_id: string): Promise<void> {
  const revokedBeforeMs = Date.now();
  await ensureAccountBanTimestampSchema();
  // Ban them
  await withAccountRehomeWriteFence({
    account_id,
    action: "ban account",
    fn: async (db) => {
      await db.query(
        `UPDATE accounts
            SET banned = TRUE,
                banned_at = CASE
                  WHEN banned IS TRUE THEN COALESCE(banned_at, NOW())
                  ELSE NOW()
                END
          WHERE account_id = $1::UUID`,
        [account_id],
      );
    },
  });
  clearIsBannedCache(account_id);
  await endAllSignInSessions(account_id);
  // Revoke host-level persistent sessions/tokens issued before this ban.
  await recordAccountRevocation(account_id, revokedBeforeMs, { banned: true });
  // Best-effort: immediately stop active runtime containers owned or sponsored
  // by the banned account. A banned collaborator alone must not take down
  // someone else's project.
  await stopRunningProjectsForBannedAccount(account_id).catch((err) => {
    logger.warn("failed to stop running projects after banning account", {
      account_id,
      err: `${err}`,
    });
  });
}

export async function removeUserBan(account_id: string): Promise<void> {
  await ensureAccountBanTimestampSchema();
  // remove their ban
  await withAccountRehomeWriteFence({
    account_id,
    action: "unban account",
    fn: async (db) => {
      await db.query(
        `UPDATE accounts
            SET banned = FALSE,
                banned_at = NULL
          WHERE account_id = $1::UUID`,
        [account_id],
      );
    },
  });
  clearIsBannedCache(account_id);
  await recordAccountSecurityState({ account_id, banned: false });
}
