import isCollaborator from "@cocalc/server/projects/is-collaborator";
// Central-hub auth adapter. Project-host has a sibling adapter at
// src/packages/project-host/conat-auth.ts.
// Both adapters intentionally share subject-policy logic from
// src/packages/conat/auth/subject-policy.ts.
import { getAccountIdFromRememberMe } from "@cocalc/server/auth/get-account";
import { parse } from "cookie";
import { getRememberMeHashFromCookieValue } from "@cocalc/server/auth/remember-me";
import LRU from "lru-cache";
import { conatPassword } from "@cocalc/backend/data";
import {
  API_COOKIE_NAME,
  HUB_PASSWORD_COOKIE_NAME,
  PROJECT_SECRET_COOKIE_NAME,
  PROJECT_ID_COOKIE_NAME,
  REMEMBER_ME_COOKIE_NAME,
} from "@cocalc/backend/auth/cookie-names";
import { getAccountWithApiKey } from "@cocalc/server/api/manage";
import { getProjectSecretToken } from "@cocalc/server/projects/control/secret-token";
import { getAdmins } from "@cocalc/server/accounts/is-admin";
import getPool from "@cocalc/database/pool";
import { verifyProjectHostToken } from "@cocalc/server/project-host/bootstrap-token";
import { getProjectHostAuthTokenPublicKey } from "@cocalc/backend/data";
import { verifyProjectHostAuthToken } from "@cocalc/conat/auth/project-host-token";
import { isValidUUID } from "@cocalc/util/misc";
import {
  type CoCalcUser,
  type CoCalcUserType,
  getCoCalcUserId,
  getCoCalcUserType,
  checkCommonPermissions,
  extractHostSubject,
  extractProjectSubject,
  isAccountAllowed as isAccountSubjectAllowed,
  isHostAllowed as isHostSubjectAllowed,
  isProjectAllowed as isProjectSubjectAllowed,
} from "@cocalc/conat/auth/subject-policy";

const COOKIES = `'${HUB_PASSWORD_COOKIE_NAME}', '${REMEMBER_ME_COOKIE_NAME}', ${API_COOKIE_NAME}, '${PROJECT_SECRET_COOKIE_NAME}' or '${PROJECT_ID_COOKIE_NAME}'`;
const DEFAULT_AGENT_SCOPES = ["browser_session"] as const;

type CoCalcUserWithAgent = CoCalcUser & {
  auth_actor?: "account" | "agent";
  auth_scopes?: string[];
};

function parseProjectHostAudienceHostId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return;
  try {
    const payload = JSON.parse(
      Buffer.from(
        parts[1].replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as { aud?: string };
    const aud = `${payload?.aud ?? ""}`;
    const prefix = "project-host:";
    if (!aud.startsWith(prefix)) return;
    const host_id = aud.slice(prefix.length);
    if (!isValidUUID(host_id)) return;
    return host_id;
  } catch {
    return;
  }
}

function verifyAgentScopedProjectHostBearer(
  bearerToken: string,
): CoCalcUserWithAgent | undefined {
  const host_id = parseProjectHostAudienceHostId(bearerToken);
  if (!host_id) return;
  try {
    const claims = verifyProjectHostAuthToken({
      token: bearerToken,
      host_id,
      public_key: getProjectHostAuthTokenPublicKey(),
    });
    if (claims.act !== "account" || !isValidUUID(claims.sub)) {
      return;
    }
    return {
      account_id: claims.sub,
      auth_actor: "agent",
      auth_scopes: [...DEFAULT_AGENT_SCOPES],
    };
  } catch {
    return;
  }
}

export async function getUser(
  socket,
  systemAccounts?: { [cookieName: string]: { password: string; user: any } },
): Promise<CoCalcUser> {
  const bearerToken = getBearerToken(socket);
  if (bearerToken) {
    const hostToken = await verifyProjectHostToken(bearerToken, {
      purpose: "master-conat",
    });
    if (hostToken) {
      return { host_id: hostToken.host_id };
    }
    const agentUser = verifyAgentScopedProjectHostBearer(bearerToken);
    if (agentUser) {
      return agentUser;
    }
    throw Error("invalid master host auth token");
  }

  if (!socket.handshake.headers.cookie) {
    throw Error(`no auth cookie set; set one of ${COOKIES}`);
  }

  const cookies = parse(socket.handshake.headers.cookie);

  if (systemAccounts != null) {
    for (const cookieName in systemAccounts) {
      if (cookies[cookieName] !== undefined) {
        if (cookies[cookieName] == systemAccounts[cookieName].password) {
          return systemAccounts[cookieName].user;
        } else {
          throw Error("invalid system account password");
        }
      }
    }
  }

  // TODO - SECURITY: we need to have host passwords and {return host_id:"host_id"} and allow hosts to publish to host-{host_id} only.

  if (cookies[HUB_PASSWORD_COOKIE_NAME]) {
    if (cookies[HUB_PASSWORD_COOKIE_NAME] == conatPassword) {
      return { hub_id: "hub" };
    } else {
      throw Error(`invalid hub password`);
    }
  }

  if (cookies[API_COOKIE_NAME]) {
    // project or account
    const user = await getAccountWithApiKey(cookies[API_COOKIE_NAME]!);
    if (!user) {
      throw Error("api key no longer valid");
    }
    return user;
  }
  if (cookies[PROJECT_SECRET_COOKIE_NAME]) {
    const project_id = cookies[PROJECT_ID_COOKIE_NAME];
    if (!project_id) {
      throw Error(
        `must specify project_id in the cookie ${PROJECT_ID_COOKIE_NAME}`,
      );
    }
    const secret = cookies[PROJECT_SECRET_COOKIE_NAME];
    if ((await getProjectSecretToken(project_id)) == secret) {
      return { project_id: project_id! };
    } else {
      throw Error("invalid secret token for project");
      // ONLY ENABLE THIS WHEN DOING DANGEROUS DEBUGGING
      // TODO -- this is NOT secure!
      //       throw Error(
      //         `invalid secret token for project: ${JSON.stringify({ correct: await getProjectSecretToken(project_id), secret })}`,
      //       );
    }
  }

  const value = cookies[REMEMBER_ME_COOKIE_NAME];
  if (!value) {
    throw Error(`must set one of the following cookies: ${COOKIES}`);
  }
  const hash = getRememberMeHashFromCookieValue(value);
  if (!hash) {
    throw Error("invalid remember me cookie");
  }
  const account_id = await getAccountIdFromRememberMe(hash);
  if (!account_id) {
    throw Error("remember me cookie expired");
  }
  return { account_id };
}

function getBearerToken(socket): string | undefined {
  const fromAuth = socket?.handshake?.auth?.bearer;
  if (typeof fromAuth === "string" && fromAuth.trim()) {
    return fromAuth.trim();
  }
  const authHeader = socket?.handshake?.headers?.authorization;
  if (typeof authHeader === "string") {
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) {
      return m[1].trim();
    }
  }
  return undefined;
}

const isAllowedCache = new LRU<string, boolean>({
  max: 10000,
  ttl: 1000 * 60, // 1 minute
});

export async function isAllowed({
  user,
  subject,
  type,
}: {
  user?: CoCalcUser | null;
  subject: string;
  type: "sub" | "pub";
}): Promise<boolean> {
  if (user == null || user?.error) {
    // non-authenticated user -- allow NOTHING
    return false;
  }
  const userType = getCoCalcUserType(user);
  if (userType == "hub") {
    // right now hubs have full permissions.
    return true;
  }
  const userId = getCoCalcUserId(user);
  const key = `${userType}-${userId}-${subject}-${type}`;
  if (isAllowedCache.has(key)) {
    return isAllowedCache.get(key)!;
  }

  const common = checkCommonPermissions({
    userId,
    userType,
    user,
    subject,
    type,
  });
  let allowed;
  if (common != null) {
    allowed = common;
  } else if (userType == "project") {
    allowed = isProjectSubjectAllowed({ project_id: userId, subject });
  } else if (userType == "account") {
    allowed = await isAccountAllowed({ account_id: userId, subject, type });
  } else if (userType == "host") {
    allowed = isHostSubjectAllowed({ host_id: userId, subject });
    if (!allowed) {
      allowed = isHostServiceAllowed({ host_id: userId, subject, type });
    }
  } else {
    allowed = false;
  }
  isAllowedCache.set(key, allowed);
  return allowed;
}

function isHostServiceAllowed({
  host_id,
  subject,
  type,
}: {
  host_id: string;
  subject: string;
  type: "sub" | "pub";
}): boolean {
  if (subject === "project-hosts.api") {
    return type === "pub";
  }
  if (subject === "project-hosts.status") {
    return type === "pub";
  }
  if (subject === "project-hosts.keys") {
    return type === "sub";
  }
  if (subject === `project-host.${host_id}.api`) {
    return type === "sub";
  }
  if (subject === `project-host.${host_id}.backup.invalidate`) {
    return type === "sub";
  }
  return false;
}

async function isAccountAllowed({
  account_id,
  subject,
}: {
  account_id: string;
  subject: string;
  type: "sub" | "pub";
}): Promise<boolean> {
  // pub and sub are the same
  if (isAccountSubjectAllowed({ account_id, subject })) {
    return true;
  }

  const v = subject.split(".");
  if (v[0] == "sys") {
    return (await getAdmins()).has(account_id);
  }

  // account accessing a project
  const project_id = extractProjectSubject(subject);
  if (!project_id) {
    // account accessing a host subject: *.host.{host_id}.>  and also *.host-{host_id}.>
    const host_id = extractHostSubject(subject);
    if (host_id) {
      return await isHostOwnerOrCollaborator({ account_id, host_id });
    }
    return false;
  }
  return await isCollaborator({ account_id, project_id });
}

async function isHostOwnerOrCollaborator({
  account_id,
  host_id,
}: {
  account_id: string;
  host_id: string;
}): Promise<boolean> {
  const { rows } = await getPool().query(
    "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [host_id],
  );
  if (!rows[0]) return false;
  const metadata = rows[0].metadata ?? {};
  if (metadata.owner === account_id) return true;
  const collabs: string[] = metadata.collaborators ?? [];
  return collabs.includes(account_id);
}

export type { CoCalcUser, CoCalcUserType };
export { getCoCalcUserType, getCoCalcUserId, checkCommonPermissions };
