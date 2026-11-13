import { createHash, randomBytes, randomUUID } from "crypto";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { tokenHash, verifyToken } from "@cocalc/backend/auth/password-hash";
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

type Queryable = Pick<PoolClient, "query">;

// Minting a host token, exchanging a bootstrap token and recording a host's
// proof of its master token take this per-host lock, so none of them can
// interleave (e.g. a proof closing the exchange while an exchange that
// already passed its check is still minting).
async function withHostTokenLock<T>(
  hostId: string,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `project-host-tokens:${hostId}`,
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function insertProjectHostToken(
  db: Queryable,
  hostId: string,
  opts: { ttlMs?: number; purpose?: string },
): Promise<ProjectHostTokenInfo> {
  const token_id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const token = `${token_id}.${secret}`;
  const token_hash = tokenHash(secret);
  const ssh_key_seed = deriveBootstrapKeySeed(secret);
  const purpose = opts.purpose ?? "bootstrap";
  const created = new Date();
  const expires = new Date(created.getTime() + (opts.ttlMs ?? DEFAULT_TTL_MS));

  await db.query(
    `UPDATE project_host_bootstrap_tokens
     SET revoked=TRUE
     WHERE host_id=$1 AND purpose=$2 AND revoked IS NOT TRUE`,
    [hostId, purpose],
  );

  await db.query(
    `INSERT INTO project_host_bootstrap_tokens
       (token_id, host_id, token_hash, ssh_key_seed, purpose, created, expires, revoked)
     VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE)`,
    [token_id, hostId, token_hash, ssh_key_seed, purpose, created, expires],
  );
  if (purpose === "master-conat") {
    // The host has not shown that it stored this new master token (a
    // rotation response can be lost), so its unexpired bootstrap tokens may
    // mint again until it proves a valid token.
    await db.query(
      `UPDATE project_host_bootstrap_tokens
       SET exchange_closed=NULL
       WHERE host_id=$1
         AND purpose='bootstrap'
         AND exchange_closed IS NOT NULL
         AND revoked IS NOT TRUE
         AND expires > NOW()`,
      [hostId],
    );
  }
  return { token, token_id, host_id: hostId, purpose, expires };
}

export async function createProjectHostToken(
  hostId: string,
  opts: { ttlMs?: number; purpose?: string } = {},
): Promise<ProjectHostTokenInfo> {
  const info = await withHostTokenLock(hostId, (db) =>
    insertProjectHostToken(db, hostId, opts),
  );
  await refreshLaunchpadOnPremAuthorizedKeys();
  return info;
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
  if (!verifyToken(secret, row.token_hash)) return null;

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

// A bootstrap token stays in the cloud provider's startup script, so it must
// not keep minting host credentials. It mints master-conat tokens only until
// the host proves that the master-conat token it holds is valid
// (proveProjectHostMasterToken, from getMasterConatTokenStatus). Until then
// the host may need it: the project-host exchanges it at every daemon start,
// and to recover a lost or revoked master token.
export async function exchangeProjectHostBootstrapToken(
  token: string,
  opts: { hostId?: string; ttlMs: number },
): Promise<
  | { ok: true; host_id: string; master: ProjectHostTokenInfo }
  | {
      ok: false;
      reason: "invalid" | "exchange_closed";
      host_id?: string;
      // Only for a verified token: never log anything from an unverified one.
      token_id?: string;
    }
> {
  const info = await verifyProjectHostToken(token, { purpose: "bootstrap" });
  if (!info || (opts.hostId != null && info.host_id !== opts.hostId)) {
    return { ok: false, reason: "invalid" };
  }
  const master = await withHostTokenLock(info.host_id, async (db) => {
    const { rows } = await db.query(
      `UPDATE project_host_bootstrap_tokens
       SET redeemed=COALESCE(redeemed, NOW())
       WHERE token_id=$1
         AND host_id=$2
         AND purpose='bootstrap'
         AND revoked IS NOT TRUE
         AND expires > NOW()
         AND exchange_closed IS NULL
       RETURNING token_id`,
      [info.token_id, info.host_id],
    );
    if (rows.length === 0) return undefined;
    await _test.hooks.afterExchangeCheck?.();
    return await insertProjectHostToken(db, info.host_id, {
      purpose: "master-conat",
      ttlMs: opts.ttlMs,
    });
  });
  if (!master) {
    return {
      ok: false,
      reason: "exchange_closed",
      host_id: info.host_id,
      token_id: info.token_id,
    };
  }
  await refreshLaunchpadOnPremAuthorizedKeys();
  return { ok: true, host_id: info.host_id, master };
}

async function isValidMasterTokenLocked(
  db: Queryable,
  hostId: string,
  masterTokenId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM project_host_bootstrap_tokens
     WHERE token_id=$1
       AND host_id=$2
       AND purpose='master-conat'
       AND revoked IS NOT TRUE
       AND expires > NOW()`,
    [masterTokenId, hostId],
  );
  return rows.length > 0;
}

// The host has shown that the master-conat token it holds is valid: its
// bootstrap tokens can no longer mint one. Re-checked under the lock: a token
// revoked by a concurrent mint is reported invalid and proves nothing.
// Tokens issued later (start, restart, reconcile), and all of them after a
// new master token is minted, are open until the host proves its token again.
export async function proveProjectHostMasterToken(
  hostId: string,
  masterTokenId: string,
): Promise<{ valid: boolean; closed: number }> {
  return await withHostTokenLock(hostId, async (db) => {
    await _test.hooks.beforeProofCheck?.();
    if (!(await isValidMasterTokenLocked(db, hostId, masterTokenId))) {
      return { valid: false, closed: 0 };
    }
    const { rowCount } = await db.query(
      `UPDATE project_host_bootstrap_tokens
       SET exchange_closed=NOW()
       WHERE host_id=$1
         AND purpose='bootstrap'
         AND exchange_closed IS NULL
         AND revoked IS NOT TRUE
         AND expires > NOW()`,
      [hostId],
    );
    return { valid: true, closed: rowCount ?? 0 };
  });
}

// Rotation with the host's current master token: the token is re-checked
// under the lock, so a token revoked by a concurrent mint can't authorize a
// new one.
export async function rotateProjectHostMasterToken(
  hostId: string,
  currentTokenId: string,
  opts: { ttlMs: number },
): Promise<ProjectHostTokenInfo | undefined> {
  const master = await withHostTokenLock(hostId, async (db) => {
    await _test.hooks.beforeRotateCheck?.();
    if (!(await isValidMasterTokenLocked(db, hostId, currentTokenId))) {
      return undefined;
    }
    return await insertProjectHostToken(db, hostId, {
      purpose: "master-conat",
      ttlMs: opts.ttlMs,
    });
  });
  if (master) {
    await refreshLaunchpadOnPremAuthorizedKeys();
  }
  return master;
}

export const _test: {
  hooks: {
    afterExchangeCheck?: () => Promise<void>;
    beforeProofCheck?: () => Promise<void>;
    beforeRotateCheck?: () => Promise<void>;
  };
} = { hooks: {} };

export async function revokeProjectHostTokensForHost(
  hostId: string,
  opts: { purpose?: string } = {},
): Promise<void> {
  const purpose = opts.purpose;
  await withHostTokenLock(hostId, async (db) => {
    await db.query(
      `UPDATE project_host_bootstrap_tokens
       SET revoked=TRUE
       WHERE host_id=$1
         ${purpose ? "AND purpose=$2" : ""}`,
      purpose ? [hostId, purpose] : [hostId],
    );
  });
  await refreshLaunchpadOnPremAuthorizedKeys();
}

async function restoreLatestRevokedTokenForPurpose(
  db: Queryable,
  hostId: string,
  purpose: string,
): Promise<boolean> {
  const { rows } = await db.query<{ token_id: string }>(
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
  await withHostTokenLock(hostId, async (db) => {
    for (const purpose of ["bootstrap", "master-conat"]) {
      if (await restoreLatestRevokedTokenForPurpose(db, hostId, purpose)) {
        restored.push(purpose);
      }
    }
  });
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
