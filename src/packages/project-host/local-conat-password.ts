import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import getLogger from "@cocalc/backend/logger";
import { secrets } from "@cocalc/backend/data";

const logger = getLogger("project-host:local-conat-password");

export const projectHostConatPasswordPath =
  process.env.COCALC_PROJECT_HOST_CONAT_PASSWORD_PATH ??
  join(secrets, "project-host-conat-password");

function generatePassword(): string {
  return randomBytes(32).toString("base64url");
}

export function getOrCreateProjectHostConatPassword(): string {
  const fromEnv = `${process.env.COCALC_PROJECT_HOST_CONAT_PASSWORD ?? ""}`.trim();
  if (fromEnv) {
    return fromEnv;
  }

  try {
    if (existsSync(projectHostConatPasswordPath)) {
      const value = readFileSync(projectHostConatPasswordPath, "utf8").trim();
      if (value) {
        return value;
      }
    }
  } catch (err) {
    logger.warn("failed reading project-host local conat password", { err });
  }

  const password = generatePassword();
  try {
    mkdirSync(dirname(projectHostConatPasswordPath), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(projectHostConatPasswordPath, `${password}\n`, {
      mode: 0o600,
    });
  } catch (err) {
    throw new Error(
      `failed writing project-host local conat password (${projectHostConatPasswordPath}): ${err}`,
    );
  }
  return password;
}

