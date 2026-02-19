import { hubApi } from "./hub";
import { getIdentity } from "./connection";
import { updateAuthorizedKeys } from "@cocalc/backend/ssh/authorized-keys";
import { join } from "node:path";
import { getLogger } from "@cocalc/project/logger";
import { delay } from "awaiting";

const logger = getLogger("conat:authorized-keys");

function isNonWritableError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

function hasProjectSshServer(): boolean {
  if (`${process.env.COCALC_SSH_SERVER_COUNT ?? ""}`.trim() === "0") {
    return false;
  }
  return `${process.env.COCALC_SSH_SERVER ?? ""}`.trim().length > 0;
}

export async function update(opts?) {
  logger.debug("update");
  if (!hasProjectSshServer()) {
    // In cocalc-plus there is no project SSH server, so syncing
    // ~/.ssh/authorized_keys is unnecessary and should be skipped.
    logger.debug(
      "skipping authorized_keys sync (no project ssh server configured)",
    );
    return "";
  }
  const { client } = getIdentity(opts);
  const api = hubApi(client);
  let keys;
  try {
    keys = await api.projects.getSshKeys();
  } catch  {
    // this happens right at startup with cocalc-lite
    await delay(3000);
    keys = await api.projects.getSshKeys();
  }
  logger.debug("got keys", keys);
  const path = join(process.env.HOME ?? "", ".ssh", "authorized_keys");
  try {
    const value = await updateAuthorizedKeys({ path, keys });
    logger.debug("updated authorized_keys files", { path });
    return value;
  } catch (err) {
    if (isNonWritableError(err)) {
      // Some users intentionally keep authorized_keys read-only.
      logger.debug("authorized_keys is not writable; skipping update", { path });
      return "";
    }
    throw err;
  }
}
