/*
Load Conat configuration from the database, in case anything is set there.
*/

import {
  conatPassword,
  conatPasswordPath,
  setConatServer,
  setConatPassword,
} from "@cocalc/backend/data";
import { secureRandomString } from "@cocalc/backend/misc";
import { writeFile } from "fs/promises";
import getLogger from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";

const logger = getLogger("server:conat:configuration");

export async function loadConatConfiguration() {
  logger.debug("loadConatConfiguration");
  const settings = await getServerSettings();
  const conat_server = (settings as any).conat_server as string | undefined;
  const conat_password = settings.conat_password as string | undefined;
  let passworkConfigured = !!conatPassword;
  if (conat_password?.trim()) {
    passworkConfigured = true;
    setConatPassword(conat_password.trim());
  }
  if (conat_server?.trim()) {
    setConatServer(conat_server.trim());
  }

  if (!passworkConfigured) {
    await initConatPassword();
  }
}

async function initConatPassword() {
  logger.debug("initConatPassword");
  const password = await secureRandomString(32);
  setConatPassword(password);
  try {
    await writeFile(conatPasswordPath, password);
  } catch (err) {
    logger.debug("initConatPassword: WARNING -- failed -- ", err);
  }
}
