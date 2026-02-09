import { readFileSync, writeFileSync, readdirSync } from "fs";
import { dirname } from "path";
import { mkdirSync } from "fs";

const DEFAULT_MASTER_CONAT_TOKEN_PATH = "/btrfs/data/secrets/master-conat-token";

export function getProjectHostMasterConatTokenPath(): string {
  return (
    process.env.COCALC_PROJECT_HOST_MASTER_CONAT_TOKEN_PATH ??
    DEFAULT_MASTER_CONAT_TOKEN_PATH
  ).trim();
}

export function getProjectHostMasterConatToken(): string | undefined {
  const fromEnv = `${process.env.COCALC_PROJECT_HOST_MASTER_CONAT_TOKEN ?? ""}`.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const tokenPath = getProjectHostMasterConatTokenPath();
  if (!tokenPath) return undefined;
  try {
    const value = readFileSync(tokenPath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function writeProjectHostMasterConatToken(token: string): void {
  const tokenPath = getProjectHostMasterConatTokenPath();
  if (!tokenPath) return;
  const value = token.trim();
  if (!value) {
    throw new Error("refusing to write empty master conat token");
  }
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
}

function bootstrapConfigCandidates(): string[] {
  const fromEnv = `${process.env.COCALC_BOOTSTRAP_CONFIG_PATH ?? ""}`.trim();
  const candidates = new Set<string>();
  if (fromEnv) {
    candidates.add(fromEnv);
  }
  candidates.add("/root/cocalc-host/bootstrap/bootstrap-config.json");
  candidates.add("/home/ubuntu/cocalc-host/bootstrap/bootstrap-config.json");
  try {
    for (const user of readdirSync("/home")) {
      candidates.add(`/home/${user}/cocalc-host/bootstrap/bootstrap-config.json`);
    }
  } catch {
    // ignore missing /home etc.
  }
  return [...candidates];
}

export function getProjectHostBootstrapToken(): string | undefined {
  const fromEnv = `${process.env.COCALC_PROJECT_HOST_BOOTSTRAP_TOKEN ?? ""}`.trim();
  if (fromEnv) return fromEnv;
  for (const path of bootstrapConfigCandidates()) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { bootstrap_token?: string };
      const token = `${parsed?.bootstrap_token ?? ""}`.trim();
      if (token) return token;
    } catch {
      // keep trying candidates
    }
  }
  return undefined;
}
