/*
This supports three actions:

- get: get the already created keys associated to an account or project
- delete: delete a specific key given by an id
- create: create a new api key associated to an account or project
- edit: edit an existing api key: you can change the name and expiration date

If the user has a password, then it must be provided and be correct. If
they have no password, then the provided one is ignored.
*/

import getPool from "@cocalc/database/pool";
import { randomBytes } from "node:crypto";
import { getLocalProjectCollaboratorAccessStatus } from "@cocalc/server/conat/project-local-access";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import passwordHash, {
  verifyPassword,
} from "@cocalc/backend/auth/password-hash";
import { getLogger } from "@cocalc/backend/logger";
import base62 from "base62/lib/ascii";
import isValidAccount from "@cocalc/server/accounts/is-valid-account";
import type {
  ApiKey as ApiKeyType,
  Action as ApiKeyAction,
} from "@cocalc/util/db-schema/api-keys";
import isBanned from "@cocalc/server/accounts/is-banned";

const log = getLogger("server:api:manage");

// Global per user limit to avoid abuse/bugs. Nobody should ever hit this.
const MAX_API_KEYS = 100000;
const API_KEY_V2_PREFIX = "sk-cocalc-v2";
const API_KEY_ID_BYTES = 18;
const API_KEY_SECRET_BYTES = 32;

let apiKeysV2SchemaReady: Promise<void> | undefined;

async function ensureApiKeysV2Schema(): Promise<void> {
  apiKeysV2SchemaReady ??= (async () => {
    const pool = getPool();
    await pool.query(
      "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_id TEXT",
    );
    await pool.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_id_unique_idx ON api_keys(key_id)",
    );
  })();
  return await apiKeysV2SchemaReady;
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function createApiKeySecret({ key_id }: { key_id: string }): string {
  return `${API_KEY_V2_PREFIX}.${key_id}.${randomBase64Url(API_KEY_SECRET_BYTES)}`;
}

function parseApiKeyV2(secret: string): { key_id: string } | undefined {
  const parts = `${secret ?? ""}`.split(".");
  if (parts.length !== 3 || parts[0] !== API_KEY_V2_PREFIX) {
    return undefined;
  }
  const key_id = parts[1]?.trim();
  const secretPart = parts[2]?.trim();
  if (!key_id || !secretPart) {
    return undefined;
  }
  return { key_id };
}

function truncApiKey(secret: string): string {
  return `${secret.slice(0, 5)}...${secret.slice(-8)}`;
}

function decode62(s: string): number {
  return base62.decode(s);
}

interface Options {
  account_id: string;
  action: ApiKeyAction;
  project_id?: string;
  name?: string;
  expire?: Date;
  id?: number;
}

// this does NOT trust its input.
export default async function manageApiKeys({
  account_id,
  action,
  project_id,
  name,
  expire,
  id,
}: Options): Promise<undefined | ApiKeyType[]> {
  log.debug("manage", { account_id, project_id, action, name, expire, id });
  if (!(await isValidAccount(account_id))) {
    throw Error("account_id is not a valid account");
  }

  // Now we allow the action.
  if (project_id != null) {
    await assertProjectCollaboratorAccessAllowRemote({
      account_id,
      project_id,
    });
  }

  return await doManageApiKeys({
    action,
    account_id,
    project_id,
    name,
    expire,
    id,
  });
}

// Return all api keys for the given account_id or project_id.
// No security checks.
async function getApiKeys({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id?: string;
}): Promise<ApiKeyType[]> {
  log.debug("getProjectApiKeys", project_id);
  const pool = getPool();
  await ensureApiKeysV2Schema();
  if (project_id) {
    const { rows } = await pool.query(
      "SELECT id,key_id,account_id,expire,created,name,trunc,last_active FROM api_keys WHERE project_id=$1::UUID ORDER BY created DESC",
      [project_id],
    );
    return rows;
  } else {
    const { rows } = await pool.query(
      "SELECT id,key_id,account_id,expire,created,name,trunc,last_active FROM api_keys WHERE account_id=$1::UUID AND project_id IS NULL ORDER BY created DESC",
      [account_id],
    );
    return rows;
  }
}

async function getApiKey({ id, account_id, project_id }) {
  const pool = getPool();
  await ensureApiKeysV2Schema();
  if (project_id) {
    const { rows } = await pool.query(
      "SELECT id,key_id,account_id,expire,created,name,trunc,last_active FROM api_keys WHERE id=$1 AND project_id=$2",
      [id, project_id],
    );
    return rows[0];
  } else {
    const { rows } = await pool.query(
      "SELECT id,key_id,account_id,expire,created,name,trunc,last_active FROM api_keys WHERE id=$1 AND account_id=$2",
      [id, account_id],
    );
    return rows[0];
  }
}

// We require the account_id here even though the id would technically suffice,
// so a user can't just delete random api keys they don't own.
// Edge case: we're not allowing
async function deleteApiKey({ account_id, project_id, id }) {
  const pool = getPool();
  if (project_id) {
    // We allow a collab on a project to delete any api key for that project,
    // even from another user.  This increases security, rather than reducing it.
    await pool.query("DELETE FROM api_keys WHERE project_id=$1 AND id=$2", [
      project_id,
      id,
    ]);
  } else {
    await pool.query("DELETE FROM api_keys WHERE account_id=$1 AND id=$2", [
      account_id,
      id,
    ]);
  }
}

async function numKeys(account_id: string): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT COUNT(*) AS count FROM api_keys WHERE account_id=$1",
    [account_id],
  );
  return rows[0].count;
}

async function createApiKey({
  account_id,
  project_id,
  expire,
  name,
}: {
  account_id: string;
  project_id?: string;
  expire?: Date;
  name: string;
}): Promise<ApiKeyType> {
  const pool = getPool();
  await ensureApiKeysV2Schema();
  if ((await numKeys(account_id)) >= MAX_API_KEYS) {
    throw Error(
      `There is a limit of ${MAX_API_KEYS} per account; please delete some api keys.`,
    );
  }
  const { rows } = await pool.query(
    "INSERT INTO api_keys(account_id,created,project_id,expire,name,key_id) VALUES($1,NOW(),$2,$3,$4,$5) RETURNING id,key_id,account_id,expire,created,name,last_active",
    [account_id, project_id, expire, name, randomBase64Url(API_KEY_ID_BYTES)],
  );
  const { id, key_id } = rows[0];
  // Note that passwordHash is NOT a "function" -- due to salt every time you call it, the output is different!
  // Thus we have to do this little trick.
  // v2 keys use a random key_id for lookup, not the local integer id.
  const secret = createApiKeySecret({ key_id });
  const trunc = truncApiKey(secret);
  const hash = passwordHash(secret);
  await pool.query("UPDATE api_keys SET trunc=$1,hash=$2 WHERE id=$3", [
    trunc,
    hash,
    id,
  ]);
  return { ...rows[0], trunc, secret };
}

async function updateApiKey({ apiKey, account_id, project_id }) {
  log.debug("udpateApiKey", apiKey);
  const pool = getPool();
  const { id, expire, name, last_active } = apiKey;
  if (project_id) {
    // including account_id and project_id so so you can't edit an api_key
    // for some other random project or user.
    await pool.query(
      "UPDATE api_keys SET expire=$3,name=$4,last_active=$5 WHERE id=$1 AND project_id=$2",
      [id, project_id, expire, name, last_active],
    );
  } else {
    await pool.query(
      "UPDATE api_keys SET expire=$3,name=$4,last_active=$5 WHERE id=$1 AND account_id=$2",
      [id, account_id, expire, name, last_active],
    );
  }
}

//api_key.slice(0, 3) + "..." + api_key.slice(-4)
// This function does no auth checks.
async function doManageApiKeys({
  action,
  account_id,
  project_id,
  name,
  expire,
  id,
}) {
  switch (action) {
    case "get":
      if (!id) {
        return await getApiKeys({ account_id, project_id });
      } else {
        return [await getApiKey({ id, account_id, project_id })];
      }

    case "delete":
      // delete key with given id
      await deleteApiKey({ account_id, project_id, id });
      break;

    case "create":
      // creates a key with given name (if given)
      return [await createApiKey({ account_id, project_id, name, expire })];

    case "edit": // change the name or expire time
      const apiKey = await getApiKey({ id, account_id, project_id });
      if (apiKey == null) {
        throw Error(`no api key with id ${id}`);
      }
      let changed = false;
      if (name != null && apiKey.name != name) {
        apiKey.name = name;
        changed = true;
      }
      if (expire !== undefined && apiKey.expire != expire) {
        apiKey.expire = expire;
        changed = true;
      }
      if (changed) {
        await updateApiKey({ apiKey, account_id, project_id });
      }
      break;
  }
}

/*
Get the account ({account_id} or {project_id}!) that has the given api key,
or returns undefined if there is no such account, or if the account
that owns the api key is banned.

If the api_key is not an account wide key, instead return the project_id
if the key is a valid key for a project.

Record that access happened by updating last_active.
*/
export async function getAccountWithApiKey(
  secret: string,
): Promise<
  | { account_id: string; project_id?: undefined }
  | { account_id?: undefined; project_id: string }
  | undefined
> {
  log.debug("getAccountWithApiKey");
  const pool = getPool("medium");
  await ensureApiKeysV2Schema();

  // Check for legacy account api key:
  if (secret.startsWith("sk_")) {
    const { rows } = await pool.query(
      "SELECT account_id FROM accounts WHERE api_key = $1::TEXT",
      [secret],
    );
    if (rows.length > 0) {
      const account_id = rows[0].account_id;
      if (await isBanned(account_id)) {
        log.debug("getAccountWithApiKey: banned api key ", account_id);
        return;
      }
      // it's a valid account api key
      log.debug("getAccountWithApiKey: valid api key for ", account_id);
      return { account_id };
    }
  }

  const v2 = parseApiKeyV2(secret);
  if (v2) {
    const { rows } = await pool.query(
      "SELECT id,account_id,project_id,hash,expire FROM api_keys WHERE key_id=$1",
      [v2.key_id],
    );
    return await checkApiKeyRows({ rows, secret });
  }

  // Check legacy sk- api_keys table format, which encoded the local integer id
  // in the presented secret. New keys must not use this format because ids are
  // per-bay local state and leak approximate key creation volume.
  if (!secret.startsWith("sk-")) {
    return undefined;
  }
  const id = decode62(secret.slice(-6));
  const { rows } = await pool.query(
    "SELECT id,account_id,project_id,hash,expire FROM api_keys WHERE id=$1",
    [id],
  );
  return await checkApiKeyRows({ rows, secret, legacy_id: id });
}

async function checkApiKeyRows({
  rows,
  secret,
  legacy_id,
}: {
  rows: any[];
  secret: string;
  legacy_id?: number;
}): Promise<
  | { account_id: string; project_id?: undefined }
  | { account_id?: undefined; project_id: string }
  | undefined
> {
  if (rows.length == 0) return undefined;
  if (await isBanned(rows[0].account_id)) {
    log.debug("getAccountWithApiKey: banned api key ", rows[0]?.account_id);
    return;
  }
  if (verifyPassword(secret, rows[0].hash)) {
    // If the creator no longer has collaborator access to the project on this bay,
    // then this project-scoped key should not authorize here. Keys that are simply
    // being checked on the wrong bay are rejected without being deleted.
    if (rows[0].project_id) {
      const account_id = rows[0].account_id;
      if (!account_id) {
        await deleteApiKey({ ...rows[0], id: rows[0].id ?? legacy_id });
        return undefined;
      }
      const access = await getLocalProjectCollaboratorAccessStatus({
        account_id,
        project_id: rows[0].project_id,
      });
      if (access === "wrong-bay") {
        log.debug(
          "getAccountWithApiKey: project api key rejected on non-owning bay",
          { account_id, project_id: rows[0].project_id },
        );
        return undefined;
      }
      if (access !== "local-collaborator") {
        await deleteApiKey({ ...rows[0], id: rows[0].id ?? legacy_id });
        return undefined;
      }
    }
    const { expire } = rows[0];
    if (expire != null && expire.valueOf() <= Date.now()) {
      // expired entries will get automatically deleted eventually by database
      // maintenance, but we obviously shouldn't depend on that.
      await deleteApiKey({ ...rows[0], id: rows[0].id ?? legacy_id });
      return undefined;
    }

    // Yes, caller definitely has a valid key.
    await getPool("medium").query(
      "UPDATE api_keys SET last_active=NOW() WHERE id=$1",
      [rows[0].id ?? legacy_id],
    );
    if (rows[0].project_id) {
      return { project_id: rows[0].project_id };
    }
    if (rows[0].account_id) {
      return { account_id: rows[0].account_id };
    }
  }
  return undefined;
}
