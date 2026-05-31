#!/usr/bin/env node

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(scriptDir, "../..");
const databaseDist = resolve(srcRoot, "packages/database/dist");
const serverDist = resolve(srcRoot, "packages/server/dist");

const hostId =
  process.env.STAR_PROJECT_HOST_ID ?? "11111111-1111-4111-8111-111111111111";
const hostName = process.env.STAR_PROJECT_HOST_NAME ?? "star-local";
const baseUrl = process.env.STAR_BASE_URL ?? "http://127.0.0.1:9100";
const defaultRootfsImage = process.env.STAR_DEFAULT_ROOTFS_IMAGE;
const masterTokenPath =
  process.env.STAR_MASTER_CONAT_TOKEN_PATH ??
  "/var/lib/cocalc/star/project-host/0/secrets/master-conat-token";
const bootstrapResultPath = process.env.STAR_BOOTSTRAP_RESULT_PATH;

if (
  process.env.COCALC_DB === "postgres" &&
  process.env.COCALC_LOCAL_POSTGRES === "1"
) {
  if (process.env.COCALC_LOCAL_PG_SOCKET_DIR != null) {
    // @cocalc/backend/logger imports @cocalc/backend/data, which captures
    // PGHOST at module import time. Set it before importing local PG helpers.
    process.env.PGHOST ??= process.env.COCALC_LOCAL_PG_SOCKET_DIR;
  }
  process.env.PGUSER ??= "smc";
  process.env.PGDATABASE ??= "smc";
  const { ensureLocalPostgres } = await import(
    `${databaseDist}/postgres/dev.js`
  );
  await ensureLocalPostgres({ enabled: true, logExports: false });
} else if (process.env.COCALC_DB !== "pglite") {
  throw new Error("CoCalc Star requires COCALC_DB=pglite or local postgres");
}

const { syncSchema } = await import(`${databaseDist}/postgres/schema/index.js`);
const poolModule = await import(`${databaseDist}/pool/index.js`);
const getPool = poolModule.default?.default ?? poolModule.default;
if (typeof getPool !== "function") {
  throw new Error("database pool module did not export getPool");
}
const { upsertProjectHost } = await import(
  `${databaseDist}/postgres/project-hosts.js`
);
const { ensureBootstrapAdminToken } = await import(
  `${serverDist}/auth/bootstrap-admin.js`
);
const { createProjectHostMasterConatToken } = await import(
  `${serverDist}/project-host/bootstrap-token.js`
);

await syncSchema();

const pool = getPool();

async function setSetting(name, value) {
  await pool.query(
    `INSERT INTO server_settings (name, value)
     VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value`,
    [name, value],
  );
}

const settings = [
  setSetting("site_name", "CoCalc Star"),
  setSetting("dns", baseUrl),
  setSetting("project_hosts_local_enabled", "yes"),
  setSetting("project_hosts_self_host_alpha_enabled", "yes"),
  setSetting("project_hosts_funding_mode", "site-funded"),
  setSetting("verify_emails", "false"),
];

if (defaultRootfsImage != null && defaultRootfsImage.trim() !== "") {
  settings.push(
    setSetting("project_rootfs_default_image", defaultRootfsImage),
    setSetting("project_rootfs_prepull_images", defaultRootfsImage),
  );
}

await Promise.all(settings);

await upsertProjectHost({
  id: hostId,
  bay_id: "bay-0",
  name: hostName,
  region: "local",
  public_url: null,
  internal_url: "http://127.0.0.1:9002",
  ssh_server: "127.0.0.1:2222",
  status: "running",
  metadata: {
    provider: "star",
    cloud_provider: "star",
    local: true,
    machine: {
      cloud: "self-host",
      metadata: {
        self_host_mode: "local",
      },
    },
    self_host: {
      http_tunnel_port: 9002,
      ssh_tunnel_port: 2222,
    },
  },
});

const issued = await createProjectHostMasterConatToken(hostId, {
  ttlMs: 1000 * 60 * 60 * 24 * 365,
});
mkdirSync(dirname(masterTokenPath), { recursive: true, mode: 0o700 });
writeFileSync(masterTokenPath, `${issued.token}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
chmodSync(masterTokenPath, 0o600);

const bootstrapUrl = await ensureBootstrapAdminToken({ baseUrl });
await pool.end();

const result = {
  ok: true,
  host_id: hostId,
  bootstrap_url: bootstrapUrl ?? null,
  master_conat_token_path: masterTokenPath,
};
const resultJson = JSON.stringify(result, null, 2);

if (bootstrapResultPath) {
  mkdirSync(dirname(bootstrapResultPath), { recursive: true, mode: 0o700 });
  writeFileSync(bootstrapResultPath, `${resultJson}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(bootstrapResultPath, 0o600);
}

console.log(resultJson);

process.exit(0);
