import { db } from "@cocalc/database";
import { is_admin } from "@cocalc/database/postgres/account/queries";

export const TRUST_ERROR_MESSAGE =
  "Only admins are allowed to create accounts through the authenticated API.";

export default async function assertTrusted(account_id: string): Promise<void> {
  if (process.env.COCALC_DB === "pglite") {
    return;
  }

  if (!(await is_admin(db(), account_id))) {
    throw new Error(TRUST_ERROR_MESSAGE);
  }
}
