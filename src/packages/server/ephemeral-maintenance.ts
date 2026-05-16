import getPool from "@cocalc/database/pool";
import deleteAccount from "@cocalc/server/accounts/delete";
import { hardDeleteProject } from "@cocalc/server/projects/hard-delete";
import { getLogger } from "@cocalc/backend/logger";
import { isValidUUID } from "@cocalc/util/misc";

const log = getLogger("server:ephemeral-maintenance");

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 25;

export default function initEphemeralMaintenance(): void {
  log.info("Starting ephemeral maintenance loop", {
    CHECK_INTERVAL_MS,
    BATCH_SIZE,
  });
  const run = async () => {
    try {
      await deleteExpiredProjects();
      await deleteExpiredAccounts();
    } catch (err) {
      log.error("ephemeral maintenance failed", err);
    }
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}

async function deleteExpiredProjects(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT project_id, users
       FROM projects
      WHERE deleted IS NOT true
        AND ephemeral IS NOT NULL
        AND ephemeral > 0
        AND created + ephemeral * interval '1 millisecond' < NOW()
      LIMIT $1`,
    [BATCH_SIZE],
  );
  for (const { project_id, users } of rows ?? []) {
    try {
      const account_id = ownerAccountIdFromUsers(users);
      if (!account_id) {
        throw new Error("ephemeral project has no valid owner");
      }
      await hardDeleteProject({
        project_id,
        account_id,
        backup_retention_days: 0,
        purge_backups_now: true,
      });
      log.info("deleted expired ephemeral project", { project_id });
    } catch (err) {
      log.error("failed to delete ephemeral project", { project_id, err });
    }
  }
}

function ownerAccountIdFromUsers(usersRaw: any): string | null {
  const users =
    typeof usersRaw === "string"
      ? JSON.parse(usersRaw)
      : usersRaw && typeof usersRaw === "object"
        ? usersRaw
        : {};
  for (const [account_id, info] of Object.entries(users)) {
    if (
      isValidUUID(account_id) &&
      info &&
      typeof info === "object" &&
      (info as any).group === "owner"
    ) {
      return account_id;
    }
  }
  return null;
}

async function deleteExpiredAccounts(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT account_id
       FROM accounts
      WHERE deleted IS NOT true
        AND ephemeral IS NOT NULL
        AND ephemeral > 0
        AND created + ephemeral * interval '1 millisecond' < NOW()
      LIMIT $1`,
    [BATCH_SIZE],
  );
  for (const { account_id } of rows ?? []) {
    try {
      await deleteAccount(account_id);
      log.info("deleted expired ephemeral account", { account_id });
    } catch (err) {
      log.error("failed to delete ephemeral account", { account_id, err });
    }
  }
}
