import { createHash, randomBytes, randomUUID } from "crypto";
import getPool from "@cocalc/database/pool";
import passwordHash, {
  verifyPassword,
} from "@cocalc/backend/auth/password-hash";
import { isValidUUID } from "@cocalc/util/misc";
import { refreshLaunchpadOnPremAuthorizedKeys } from "../launchpad/onprem-sshd";

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

export type ProjectHostTokenInfo = {
  token: string;
  token_id: string;
  host_id: string;
  purpose: string;
  expires: Date;
};

function pool() {
  return getPool();
}

function splitToken(token: string): { tokenId: string; secret: string } | null {
  const parts = token.split(".", 2);
  if (parts.length !== 2) return null;
  const [tokenId, secret] = parts;
  if (!tokenId || !secret) return null;
  if (!isValidUUID(tokenId)) return null;
  return { tokenId, secret };
}

function deriveBootstrapKeySeed(secret: string): string {
  return createHash("sha256")
    .update("cocalc-ssh-bootstrap:")
    .update(secret)
    .digest("base64url");
}

export async function createProjectHostToken(
  hostId: string,
  opts: { ttlMs?: number; purpose?: string } = {},
): Promise<ProjectHostTokenInfo> {
  const token_id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const token = `${token_id}.${secret}`;
  const token_hash = passwordHash(secret);
  const ssh_key_seed = deriveBootstrapKeySeed(secret);
  const purpose = opts.purpose ?? "bootstrap";
  const created = new Date();
  const expires = new Date(created.getTime() + (opts.ttlMs ?? DEFAULT_TTL_MS));

  await pool().query(
    `UPDATE project_host_bootstrap_tokens
     SET revoked=TRUE
     WHERE host_id=$1 AND purpose=$2 AND revoked IS NOT TRUE`,
    [hostId, purpose],
  );

  await pool().query(
    `INSERT INTO project_host_bootstrap_tokens
       (token_id, host_id, token_hash, ssh_key_seed, purpose, created, expires, revoked)
     VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE)`,
    [token_id, hostId, token_hash, ssh_key_seed, purpose, created, expires],
  );
  await refreshLaunchpadOnPremAuthorizedKeys();

  return { token, token_id, host_id: hostId, purpose, expires };
}

export async function verifyProjectHostToken(
  token: string,
  opts: { purpose?: string } = {},
): Promise<{
  token_id: string;
  host_id: string;
  purpose: string;
  expires: Date;
} | null> {
  const parsed = splitToken(token);
  if (!parsed) return null;
  const { tokenId, secret } = parsed;
  const purpose = opts.purpose;
  const { rows } = await pool().query<{
    token_hash: string;
    host_id: string;
    purpose: string;
    expires: Date;
  }>(
    `SELECT token_hash, host_id, purpose, expires
     FROM project_host_bootstrap_tokens
     WHERE token_id=$1
       AND revoked IS NOT TRUE
       AND expires > NOW()
       ${purpose ? "AND purpose=$2" : ""}`,
    purpose ? [tokenId, purpose] : [tokenId],
  );
  const row = rows[0];
  if (!row) return null;
  if (!verifyPassword(secret, row.token_hash)) return null;

  await pool().query(
    `UPDATE project_host_bootstrap_tokens
     SET last_used=NOW()
     WHERE token_id=$1`,
    [tokenId],
  );

  return {
    token_id: tokenId,
    host_id: row.host_id,
    purpose: row.purpose,
    expires: row.expires,
  };
}

export async function revokeProjectHostTokensForHost(
  hostId: string,
  opts: { purpose?: string } = {},
): Promise<void> {
  const purpose = opts.purpose;
  await pool().query(
    `UPDATE project_host_bootstrap_tokens
     SET revoked=TRUE
     WHERE host_id=$1
       ${purpose ? "AND purpose=$2" : ""}`,
    purpose ? [hostId, purpose] : [hostId],
  );
  await refreshLaunchpadOnPremAuthorizedKeys();
}

async function restoreLatestRevokedTokenForPurpose(
  hostId: string,
  purpose: string,
): Promise<boolean> {
  const { rows } = await pool().query<{ token_id: string }>(
    `
      WITH active AS (
        SELECT token_id
        FROM project_host_bootstrap_tokens
        WHERE host_id=$1
          AND purpose=$2
          AND revoked IS NOT TRUE
          AND expires > NOW()
        LIMIT 1
      ),
      candidate AS (
        SELECT token_id
        FROM project_host_bootstrap_tokens
        WHERE host_id=$1
          AND purpose=$2
          AND revoked IS TRUE
          AND expires > NOW()
        ORDER BY created DESC
        LIMIT 1
      )
      UPDATE project_host_bootstrap_tokens
      SET revoked=FALSE
      WHERE token_id IN (SELECT token_id FROM candidate)
        AND NOT EXISTS (SELECT 1 FROM active)
      RETURNING token_id
    `,
    [hostId, purpose],
  );
  return rows.length > 0;
}

export async function restoreProjectHostTokensForRestart(
  hostId: string,
): Promise<{ restored: string[] }> {
  const restored: string[] = [];
  for (const purpose of ["bootstrap", "master-conat"]) {
    if (await restoreLatestRevokedTokenForPurpose(hostId, purpose)) {
      restored.push(purpose);
    }
  }
  if (restored.length > 0) {
    await refreshLaunchpadOnPremAuthorizedKeys();
  }
  return { restored };
}

export async function createProjectHostBootstrapToken(
  hostId: string,
  opts: { ttlMs?: number } = {},
): Promise<ProjectHostTokenInfo> {
  return await createProjectHostToken(hostId, {
    ...opts,
    purpose: "bootstrap",
  });
}

export async function createProjectHostMasterConatToken(
  hostId: string,
  opts: { ttlMs?: number } = {},
): Promise<ProjectHostTokenInfo> {
  return await createProjectHostToken(hostId, {
    ...opts,
    purpose: "master-conat",
  });
}

// Backward-compatible aliases; prefer create/verify/revokeProjectHost* names.
export type BootstrapTokenInfo = ProjectHostTokenInfo;
export const createBootstrapToken = createProjectHostToken;
export const verifyBootstrapToken = verifyProjectHostToken;
export const revokeBootstrapTokensForHost = revokeProjectHostTokensForHost;
