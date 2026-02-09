import { readFileSync } from "fs";

const DEFAULT_MASTER_CONAT_TOKEN_PATH = "/btrfs/data/secrets/master-conat-token";

export function getProjectHostMasterConatToken(): string | undefined {
  const fromEnv = `${process.env.COCALC_PROJECT_HOST_MASTER_CONAT_TOKEN ?? ""}`.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const tokenPath = (
    process.env.COCALC_PROJECT_HOST_MASTER_CONAT_TOKEN_PATH ??
    DEFAULT_MASTER_CONAT_TOKEN_PATH
  ).trim();
  if (!tokenPath) return undefined;
  try {
    const value = readFileSync(tokenPath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

