import getLogger from "@cocalc/backend/logger";
import getPool, { getTransactionClient } from "@cocalc/database/pool";
import {
  decryptRegistrationTokenValue,
  encryptRegistrationTokenValue,
  isHashedRegistrationTokenValue,
} from "@cocalc/database/postgres/account/registration-token-secret";
import siteURL from "@cocalc/database/settings/site-url";
import { isRocketProduct } from "@cocalc/server/launchpad/mode";
import { secure_random_token } from "@cocalc/util/misc";

const logger = getLogger("server:auth:bootstrap-admin");

const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;

type BootstrapToken = {
  token: string;
  expires: Date | null;
  storedToken: string;
};

type QueryClient = {
  query: (query: string, params?: any[]) => Promise<{ rows: any[] }>;
};

let cachedBootstrapToken: BootstrapToken | undefined;
let cachedStarInviteToken: BootstrapToken | undefined;

function isBootstrapCustomize(customize: unknown): boolean {
  return (
    !!customize &&
    typeof customize === "object" &&
    (customize as { bootstrap?: boolean }).bootstrap === true
  );
}

function isStarInviteCustomize(customize: unknown): boolean {
  return (
    !!customize &&
    typeof customize === "object" &&
    (customize as { star_invite?: boolean }).star_invite === true
  );
}

async function findBootstrapToken(
  client: QueryClient = getPool("long"),
): Promise<BootstrapToken | undefined> {
  await client.query(
    `DELETE FROM registration_tokens
      WHERE customize->>'bootstrap'='true'
        AND (
          disabled IS TRUE OR
          (expires IS NOT NULL AND expires <= NOW()) OR
          ("limit" IS NOT NULL AND "limit" <= coalesce(counter, 0))
        )`,
  );
  const { rows } = await client.query(
    `SELECT token, expires, customize
       FROM registration_tokens
      WHERE disabled IS NOT true
        AND (expires IS NULL OR expires > NOW())
        AND ("limit" IS NULL OR "limit" > coalesce(counter, 0))
      ORDER BY expires NULLS LAST, token
      LIMIT 100`,
  );
  for (const row of rows ?? []) {
    if (isBootstrapCustomize(row.customize)) {
      if (isHashedRegistrationTokenValue(row.token)) {
        if (cachedBootstrapToken?.storedToken === row.token) {
          return cachedBootstrapToken;
        }
        await client.query("DELETE FROM registration_tokens WHERE token=$1", [
          row.token,
        ]);
        logger.warn(
          "deleted unrecoverable hash-only bootstrap token; creating replacement",
          { expires: row.expires?.toISOString?.() ?? null },
        );
        continue;
      }
      const token = await decryptRegistrationTokenValue(row.token);
      const storedToken = row.token;
      cachedBootstrapToken = {
        token,
        storedToken,
        expires: row.expires ?? null,
      };
      return cachedBootstrapToken;
    }
  }
  return undefined;
}

async function findStarInviteToken(
  client: QueryClient = getPool("long"),
): Promise<BootstrapToken | undefined> {
  await client.query(
    `DELETE FROM registration_tokens
      WHERE customize->>'star_invite'='true'
        AND (
          disabled IS TRUE OR
          (expires IS NOT NULL AND expires <= NOW()) OR
          ("limit" IS NOT NULL AND "limit" <= coalesce(counter, 0))
        )`,
  );
  const { rows } = await client.query(
    `SELECT token, expires, customize
       FROM registration_tokens
      WHERE disabled IS NOT true
        AND (expires IS NULL OR expires > NOW())
        AND ("limit" IS NULL OR "limit" > coalesce(counter, 0))
      ORDER BY expires NULLS LAST, token
      LIMIT 100`,
  );
  for (const row of rows ?? []) {
    if (isStarInviteCustomize(row.customize)) {
      if (isHashedRegistrationTokenValue(row.token)) {
        if (cachedStarInviteToken?.storedToken === row.token) {
          return cachedStarInviteToken;
        }
        await client.query("DELETE FROM registration_tokens WHERE token=$1", [
          row.token,
        ]);
        logger.warn(
          "deleted unrecoverable hash-only star invite token; creating replacement",
          { expires: row.expires?.toISOString?.() ?? null },
        );
        continue;
      }
      const token = await decryptRegistrationTokenValue(row.token);
      const storedToken = row.token;
      cachedStarInviteToken = {
        token,
        storedToken,
        expires: row.expires ?? null,
      };
      return cachedStarInviteToken;
    }
  }
  return undefined;
}

async function createBootstrapToken(
  client: QueryClient = getPool(),
): Promise<BootstrapToken> {
  const token = secure_random_token(32);
  const storedToken = await encryptRegistrationTokenValue(token);
  const expires = new Date(Date.now() + BOOTSTRAP_TTL_MS);
  await client.query(
    `INSERT INTO registration_tokens
        (token, descr, expires, "limit", disabled, customize)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      storedToken,
      "Bootstrap Admin",
      expires,
      1,
      false,
      { make_admin: true, bootstrap: true },
    ],
  );
  cachedBootstrapToken = { token, storedToken, expires };
  return cachedBootstrapToken;
}

async function createStarInviteToken(
  client: QueryClient = getPool(),
): Promise<BootstrapToken> {
  const token = secure_random_token(32);
  const storedToken = await encryptRegistrationTokenValue(token);
  await client.query(
    `INSERT INTO registration_tokens
        (token, descr, expires, "limit", disabled, customize)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      storedToken,
      "CoCalc Star Invite",
      null,
      null,
      false,
      { star_invite: true },
    ],
  );
  cachedStarInviteToken = { token, storedToken, expires: null };
  return cachedStarInviteToken;
}

async function getOrCreateBootstrapToken(): Promise<BootstrapToken> {
  const client = await getTransactionClient();
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('cocalc-bootstrap-admin-token'))",
    );
    let tokenInfo = await findBootstrapToken(client);
    if (!tokenInfo) {
      tokenInfo = await createBootstrapToken(client);
    }
    await client.query("COMMIT");
    return tokenInfo;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getOrCreateStarInviteToken(): Promise<BootstrapToken> {
  const client = await getTransactionClient();
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('cocalc-star-invite-token'))",
    );
    let tokenInfo = await findStarInviteToken(client);
    if (!tokenInfo) {
      tokenInfo = await createStarInviteToken(client);
    }
    await client.query("COMMIT");
    return tokenInfo;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function formatBootstrapLink(
  token: string,
  baseUrl?: string,
): Promise<string> {
  const base = withTrailingSlash(baseUrl ?? (await siteURL()));
  const url = new URL("auth/sign-up", base);
  url.searchParams.set("registrationToken", token);
  url.searchParams.set("bootstrap", "1");
  return url.toString();
}

async function formatRegistrationLink(
  token: string,
  baseUrl?: string,
): Promise<string> {
  const base = withTrailingSlash(baseUrl ?? (await siteURL()));
  const url = new URL("auth/sign-up", base);
  url.searchParams.set("registrationToken", token);
  return url.toString();
}

export async function ensureBootstrapAdminToken(
  opts: { baseUrl?: string } = {},
): Promise<string | undefined> {
  if (isRocketProduct()) {
    return;
  }
  const pool = getPool("long");
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM accounts WHERE coalesce(deleted,false)=false AND 'admin' = ANY(groups)",
  );
  if ((rows?.[0]?.count ?? 0) > 0) {
    return;
  }

  const tokenInfo = await getOrCreateBootstrapToken();

  const url = await formatBootstrapLink(tokenInfo.token, opts.baseUrl);
  logger.info("bootstrap admin token ready", {
    expires: tokenInfo.expires?.toISOString() ?? null,
  });
  return url;
}

export async function ensureStarInviteRegistrationToken(
  opts: { baseUrl?: string } = {},
): Promise<string> {
  const tokenInfo = await getOrCreateStarInviteToken();
  const url = await formatRegistrationLink(tokenInfo.token, opts.baseUrl);
  logger.info("star invite registration token ready");
  return url;
}
