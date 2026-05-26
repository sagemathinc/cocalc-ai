import LRU from "lru-cache";
import { callback2 } from "@cocalc/util/async-utils";
import getLogger from "../logger";
import { getDatabase } from "../servers/database";
const {
  user_has_write_access_to_project,
  user_has_read_access_to_project,
} = require("../access");
import generateHash from "@cocalc/server/auth/hash";
import { getAccountWithApiKey } from "@cocalc/server/api/manage";
import { requireApiKeyProjectCapability } from "@cocalc/server/api/api-key-scope";
import isCollaborator from "@cocalc/server/projects/is-collaborator";
import {
  ensureAccountSecurityStateReady,
  isAccountBannedCached,
  startAccountSecurityStateSyncLoop,
} from "@cocalc/server/accounts/security-state";

const logger = getLogger("proxy:has-access");

startAccountSecurityStateSyncLoop();

type AccessResult = {
  access: boolean;
  account_id?: string;
};

interface Options {
  project_id: string;
  remember_me?: string;
  api_key?: string;
  type: "write" | "read";
  isPersonal: boolean;
}

interface ResolveAuthenticatedAccountIdOptions {
  remember_me?: string;
  api_key?: string;
}

// 1 minute cache: grant "yes" for a while, but still re-check banned state
// from the replicated in-memory security cache before using a cached grant.
const yesCache = new LRU<string, AccessResult>({
  max: 20000,
  ttl: 1000 * 60 * 1.5,
});
// 5 second cache: recheck "no" much more frequently
const noCache = new LRU<string, boolean>({ max: 20000, ttl: 1000 * 15 });

export default async function hasAccess(opts: Options): Promise<boolean> {
  if (opts.isPersonal) {
    // In personal mode, anyone who can access localhost has full
    // access to everything, since this is meant to be used on
    // single-user personal computer in a context where there is no
    // security requirement at all.
    return true;
  }

  const { project_id, remember_me, api_key, type } = opts;
  const key = `${project_id}${remember_me}${api_key}${type}`;

  const cachedYes = yesCache.get(key);
  if (cachedYes != null) {
    if (
      cachedYes.account_id != null &&
      isAccountBannedCached(cachedYes.account_id)
    ) {
      yesCache.delete(key);
      noCache.set(key, false);
      return false;
    }
    return cachedYes.access;
  }
  if (noCache.has(key)) {
    return false;
  }

  // not cached, so we determine access.
  let result: AccessResult;
  const dbg = (...args) => {
    logger.debug(type, " access to ", project_id, ...args);
  };

  try {
    result = await checkForAccess({
      project_id,
      remember_me,
      api_key,
      type,
      dbg,
    });
  } catch (err) {
    dbg("error trying to determine access; denying for now", `${err}`);
    result = { access: false };
  }
  const { access } = result;
  dbg("determined that access=", access);

  if (access) {
    yesCache.set(key, result);
  } else {
    noCache.set(key, access);
  }
  return access;
}

export async function resolveAuthenticatedAccountId({
  remember_me,
  api_key,
}: ResolveAuthenticatedAccountIdOptions): Promise<string | undefined> {
  if (remember_me) {
    const account_id = await resolveRememberMeAccountId(remember_me);
    if (account_id) {
      return account_id;
    }
  }
  if (api_key) {
    return await resolveApiKeyAccountId(api_key);
  }
  return;
}

async function checkForAccess({
  project_id,
  remember_me,
  api_key,
  type,
  dbg,
}): Promise<AccessResult> {
  if (remember_me) {
    const { access, account_id, error } = await checkForRememberMeAccess({
      project_id,
      remember_me,
      type,
      dbg,
    });
    if (access) {
      return { access, account_id };
    }
    if (!api_key) {
      // only finish if no api key:
      if (error) {
        throw Error(error);
      } else {
        return { access, account_id };
      }
    }
  }

  if (api_key) {
    const { access, account_id, error } = await checkForApiKeyAccess({
      project_id,
      api_key,
      type,
      dbg,
    });
    if (access) {
      return { access, account_id };
    }
    if (error) {
      throw Error(error);
    }
    return { access, account_id };
  }

  throw Error(
    "you must authenticate with either an api_key or remember_me cookie, but neither is set",
  );
}

async function checkForRememberMeAccess({
  project_id,
  remember_me,
  type,
  dbg,
}): Promise<{ access: boolean; account_id?: string; error?: string }> {
  const database = getDatabase();
  dbg("get remember_me message");
  const x = remember_me.split("$");
  const hash = generateHash(x[0], x[1], parseInt(x[2]), x[3]);
  const signed_in_mesg = await callback2(database.get_remember_me, {
    hash,
    cache: true,
  });
  if (signed_in_mesg == null) {
    return { access: false, error: "not signed in via remember_me" };
  }

  let access: boolean = false;
  const { account_id, email_address } = signed_in_mesg;
  await ensureAccountSecurityStateReady();
  if (isAccountBannedCached(account_id)) {
    return { access: false, account_id, error: "banned" };
  }
  dbg({ account_id, email_address });

  dbg(`now check if user has access to project`);
  if (type === "write") {
    access = await callback2(user_has_write_access_to_project, {
      database,
      project_id,
      account_id,
    });
    if (access) {
      // Record that user is going to actively access
      // this project.  This is important since it resets
      // the idle timeout.
      database.touch({
        account_id,
        project_id,
      });
    }
  } else if (type == "read") {
    access = await callback2(user_has_read_access_to_project, {
      database,
      project_id,
      account_id,
    });
  } else {
    return { access: false, error: `invalid access type ${type}` };
  }
  return { access, account_id };
}

async function resolveRememberMeAccountId(
  remember_me: string,
): Promise<string | undefined> {
  const database = getDatabase();
  const x = remember_me.split("$");
  const hash = generateHash(x[0], x[1], parseInt(x[2]), x[3]);
  const signed_in_mesg = await callback2(database.get_remember_me, {
    hash,
    cache: true,
  });
  const account_id = `${signed_in_mesg?.account_id ?? ""}`.trim();
  if (!account_id) {
    return;
  }
  await ensureAccountSecurityStateReady();
  if (isAccountBannedCached(account_id)) {
    return;
  }
  return account_id;
}

async function checkForApiKeyAccess({ project_id, api_key, type, dbg }) {
  // we don't have a notion of "read" access, for type.
  dbg("checkForApiKeyAccess", { project_id, type });
  const user = await getAccountWithApiKey(api_key);
  if (user == null) {
    dbg("api key is not valid (probably expired)");
    return { access: false, error: "invalid or expired api key" };
  }
  try {
    requireApiKeyProjectCapability(user, "project:exec", project_id);
  } catch (err) {
    dbg("api key denied by project capability scope", `${err}`);
    return { access: false, account_id: user.account_id, error: `${err}` };
  }
  return {
    account_id: user.account_id,
    access: await isCollaborator({ account_id: user.account_id, project_id }),
  };
}

async function resolveApiKeyAccountId(
  api_key: string,
): Promise<string | undefined> {
  const user = await getAccountWithApiKey(api_key);
  if (!user?.account_id) {
    return;
  }
  return user.account_id;
}
