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
const masterTokenPath =
  process.env.STAR_MASTER_CONAT_TOKEN_PATH ??
  "/var/lib/cocalc/star/project-host/0/secrets/master-conat-token";

if (process.env.COCALC_DB !== "pglite") {
  throw new Error("seed-star-poc requires COCALC_DB=pglite");
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

await Promise.all([
  setSetting("site_name", "CoCalc Star POC"),
  setSetting("dns", baseUrl),
  setSetting("project_hosts_local_enabled", "yes"),
  setSetting("project_hosts_self_host_alpha_enabled", "yes"),
  setSetting("project_hosts_funding_mode", "site-funded"),
  setSetting("verify_emails", "false"),
]);

await upsertProjectHost({
  id: hostId,
  name: hostName,
  region: "local",
  public_url: "http://127.0.0.1:9002",
  internal_url: "http://127.0.0.1:9002",
  ssh_server: "127.0.0.1:2222",
  status: "running",
  metadata: {
    provider: "star-poc",
    cloud_provider: "star-poc",
    local: true,
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

console.log(
  JSON.stringify(
    {
      ok: true,
      host_id: hostId,
      bootstrap_url: bootstrapUrl ?? null,
      master_conat_token_path: masterTokenPath,
    },
    null,
    2,
  ),
);
