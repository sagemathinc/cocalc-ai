import getPool from "@cocalc/database/pool";
import { assertAccountWriteOnHomeBay } from "@cocalc/server/accounts/rehome-fence";
import { isValidUUID } from "@cocalc/util/misc";

/** This is a normal non-admin account, not a project-restricted session. */
export async function assertBrowserTestingAccount(
  account_id: string,
  expected: string,
) {
  if (!isValidUUID(expected) || account_id !== expected)
    throw new Error(
      "Testing browser requires a login to the exact testing account",
    );
  const allowed = (process.env.COCALC_BROWSER_TEST_ACCOUNT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!allowed.includes(account_id))
    throw new Error(
      "Account is not designated for browser testing on this site",
    );
  const db = getPool();
  await assertAccountWriteOnHomeBay({
    db,
    account_id,
    action: "issue testing browser session",
  });
  const { rows } = await db.query(
    "SELECT groups, banned, deleted FROM accounts WHERE account_id=$1",
    [account_id],
  );
  const account = rows[0];
  if (
    !account ||
    account.banned ||
    account.deleted ||
    account.groups?.includes("admin")
  )
    throw new Error("Browser testing requires an active non-admin account");
}
