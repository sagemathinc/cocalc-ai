import getPool from "@cocalc/database/pool";
import { isLaunchpadProduct } from "@cocalc/server/launchpad/mode";

export default async function getRequiresTokens(): Promise<boolean> {
  if (isLaunchpadProduct()) {
    // SAFETY: Launchpad must always require registration tokens to prevent
    // accidental public signups after the bootstrap admin token is used.
    return true;
  }
  const pool = getPool("long");
  const { rows } = await pool.query(
    "SELECT EXISTS(SELECT 1 FROM registration_tokens WHERE disabled IS NOT true) AS have_tokens"
  );
  return !!rows[0]?.have_tokens;
}
