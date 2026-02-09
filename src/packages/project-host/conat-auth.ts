import type { AllowFunction, UserFunction } from "@cocalc/conat/core/server";
// Project-host auth adapter. Central hub has a sibling adapter at
// src/packages/server/conat/socketio/auth.ts.
// Both adapters share subject-level policy via
// src/packages/conat/auth/subject-policy.ts.
import {
  checkCommonPermissions,
  extractProjectSubject,
  getCoCalcUserId,
  getCoCalcUserType,
  isAccountAllowed as isAccountSubjectAllowed,
  isProjectCollaboratorGroup,
  type CoCalcUser,
} from "@cocalc/conat/auth/subject-policy";
import { verifyProjectHostAuthToken } from "@cocalc/conat/auth/project-host-token";
import { getRow } from "@cocalc/lite/hub/sqlite/database";
import TTL from "@isaacs/ttlcache";
import { getProjectHostAuthPublicKey } from "./auth-public-key";
import { HUB_PASSWORD_COOKIE_NAME } from "@cocalc/backend/auth/cookie-names";
import { conatPassword } from "@cocalc/backend/data";

const authDecisionCache = new TTL<string, boolean>({
  max: 20_000,
  ttl: 60_000,
});

const collaboratorCache = new TTL<string, boolean>({
  max: 50_000,
  ttl: 30_000,
});

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    const value = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function readBearerToken(socket): string {
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
  throw new Error("missing project-host bearer token");
}

function isProjectCollaboratorLocal({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): boolean {
  if (account_id === project_id) {
    // project identity user (legacy case) can always access itself.
    return true;
  }
  const key = `${account_id}:${project_id}`;
  if (collaboratorCache.has(key)) {
    return collaboratorCache.get(key)!;
  }
  const row = getRow("projects", JSON.stringify({ project_id }));
  const userEntry = row?.users?.[account_id];
  const group =
    typeof userEntry === "string" ? userEntry : userEntry?.group;
  const allowed = isProjectCollaboratorGroup(group);
  collaboratorCache.set(key, allowed);
  return allowed;
}

function clearAuthCaches() {
  authDecisionCache.clear();
  collaboratorCache.clear();
}

export function clearProjectHostConatAuthCaches() {
  clearAuthCaches();
}

export function createProjectHostConatAuth({
  host_id,
}: {
  host_id: string;
}): {
  getUser: UserFunction;
  isAllowed: AllowFunction;
  clearCaches: () => void;
} {
  const getUser: UserFunction = async (socket, systemAccounts) => {
    const cookies = socket?.handshake?.headers?.cookie
      ? parseCookies(socket.handshake.headers.cookie)
      : undefined;
    if (systemAccounts && cookies) {
      for (const cookieName in systemAccounts) {
        if (cookies?.[cookieName] !== undefined) {
          const expected = systemAccounts[cookieName];
          if (cookies[cookieName] === expected.password) {
            return expected.user;
          }
          throw new Error("invalid system account password");
        }
      }
    }
    // Compatibility path: some internal project-host clients authenticate using
    // the shared hub-password cookie name. In project-host runtime this value is
    // a host-local secret (not the central hub secret).
    if (
      cookies?.[HUB_PASSWORD_COOKIE_NAME] &&
      cookies[HUB_PASSWORD_COOKIE_NAME] === conatPassword
    ) {
      return { hub_id: "system" };
    }
    const token = readBearerToken(socket);
    const claims = verifyProjectHostAuthToken({
      token,
      host_id,
      // Verify-only key: project-host does not get signing capability.
      public_key: getProjectHostAuthPublicKey(),
    });
    return { account_id: claims.sub } satisfies CoCalcUser;
  };

  const isAllowed: AllowFunction = async ({ user, subject, type }) => {
    if (user == null || user?.error) {
      return false;
    }

    const userType = getCoCalcUserType(user);
    if (userType === "hub") {
      // Local internal services authenticate using the system account.
      return true;
    }
    if (userType !== "account") {
      // Project-host websocket auth currently only allows account identities.
      return false;
    }

    const userId = getCoCalcUserId(user);
    const cacheKey = `${userType}:${userId}:${type}:${subject}`;
    if (authDecisionCache.has(cacheKey)) {
      return authDecisionCache.get(cacheKey)!;
    }

    const common = checkCommonPermissions({
      user,
      userType,
      userId,
      subject,
      type,
    });
    let allowed = false;
    if (common != null) {
      allowed = common;
    } else if (isAccountSubjectAllowed({ account_id: userId, subject })) {
      allowed = true;
    } else {
      const project_id = extractProjectSubject(subject);
      if (project_id) {
        allowed = isProjectCollaboratorLocal({
          account_id: userId,
          project_id,
        });
      }
    }

    authDecisionCache.set(cacheKey, allowed);
    return allowed;
  };

  return {
    getUser,
    isAllowed,
    clearCaches: clearAuthCaches,
  };
}
