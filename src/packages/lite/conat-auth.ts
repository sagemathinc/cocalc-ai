/*
 * Lite Conat authentication and authorization policy.
 *
 * This adapter enforces:
 * - browser cookie auth when AUTH_TOKEN is enabled
 * - optional agent-scoped bearer auth for automation
 * - explicit opt-in for unauthenticated conat on non-loopback hosts
 */

import { timingSafeEqual } from "node:crypto";
import type { AllowFunction, UserFunction } from "@cocalc/conat/core/server";
import { verifyPassword } from "@cocalc/backend/auth/password-hash";
import {
  checkCommonPermissions,
  extractProjectSubject,
  getCoCalcUserId,
  getCoCalcUserType,
  isAccountAllowed as isAccountSubjectAllowed,
  isProjectAllowed as isProjectSubjectAllowed,
  type CoCalcUser,
} from "@cocalc/conat/auth/subject-policy";
import { HUB_PASSWORD_COOKIE_NAME } from "@cocalc/backend/auth/cookie-names";
import { getAuthCookieName, parseCookies } from "./auth-token";
import { isLoopbackHost } from "@cocalc/backend/network/policy";
import { isValidUUID } from "@cocalc/util/misc";

export const DEFAULT_AGENT_SCOPES = ["browser_session"] as const;

type LiteAuthActor = "account" | "agent";

type LiteConatUser = CoCalcUser & {
  auth_actor?: LiteAuthActor;
  auth_scopes?: string[];
};

function parseBoolean(value: string | undefined): boolean {
  const v = `${value ?? ""}`.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function allowUnauthenticatedConat(): boolean {
  return parseBoolean(process.env.COCALC_ALLOW_UNAUTHENTICATED_CONAT);
}

function readBearerToken(socket): string | undefined {
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

function safeEqualStr(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function allowAgentServiceSubject({
  account_id,
  subject,
}: {
  account_id: string;
  subject: string;
}): boolean {
  const accountServicePrefix = `services.account-${account_id}.`;
  if (!subject.startsWith(accountServicePrefix)) return false;
  return subject.endsWith(".browser-session");
}

function isAgentScoped(user: LiteConatUser): boolean {
  return user.auth_actor === "agent";
}

function hasAgentScope(user: LiteConatUser, scope: string): boolean {
  return !!user.auth_scopes?.includes(scope);
}

function isAccountAllowed({
  account_id,
  local_project_id,
  subject,
}: {
  account_id: string;
  local_project_id: string;
  subject: string;
}): boolean {
  if (isAccountSubjectAllowed({ account_id, subject })) {
    return true;
  }
  const project_id = extractProjectSubject(subject);
  if (project_id) {
    return project_id === local_project_id;
  }
  return false;
}

function enforceConatExposurePolicy({
  bindHost,
  AUTH_TOKEN,
}: {
  bindHost: string;
  AUTH_TOKEN?: string;
}): void {
  if (AUTH_TOKEN) return;
  if (isLoopbackHost(bindHost)) return;
  if (allowUnauthenticatedConat()) return;
  throw new Error(
    "lite conat auth: AUTH_TOKEN is not set on a non-loopback host. " +
      "Set AUTH_TOKEN, or explicitly opt in with COCALC_ALLOW_UNAUTHENTICATED_CONAT=true.",
  );
}

export function createLiteConatAuth({
  account_id,
  project_id,
  bindHost,
  AUTH_TOKEN,
  AGENT_TOKEN,
  agent_scopes = [...DEFAULT_AGENT_SCOPES],
  hub_password,
}: {
  account_id: string;
  project_id: string;
  bindHost: string;
  AUTH_TOKEN?: string;
  AGENT_TOKEN?: string;
  agent_scopes?: string[];
  hub_password?: string;
}): {
  getUser: UserFunction;
  isAllowed: AllowFunction;
} {
  if (!isValidUUID(account_id)) {
    throw new Error("invalid account_id for lite conat auth");
  }
  if (!isValidUUID(project_id)) {
    throw new Error("invalid project_id for lite conat auth");
  }

  enforceConatExposurePolicy({ bindHost, AUTH_TOKEN });
  const allowOpenConat = !AUTH_TOKEN && isLoopbackHost(bindHost);

  const getUser: UserFunction = async (socket, systemAccounts) => {
    const cookies = parseCookies(socket?.handshake?.headers?.cookie);

    if (systemAccounts) {
      for (const cookieName of Object.keys(systemAccounts)) {
        const expected = systemAccounts[cookieName];
        if (cookies[cookieName] == null) continue;
        if (cookies[cookieName] === expected.password) {
          return expected.user;
        }
        throw new Error("invalid system account password");
      }
    }

    if (
      hub_password &&
      cookies[HUB_PASSWORD_COOKIE_NAME] &&
      safeEqualStr(cookies[HUB_PASSWORD_COOKIE_NAME], hub_password)
    ) {
      return { hub_id: "system" };
    }

    const bearer = readBearerToken(socket);
    if (AGENT_TOKEN && bearer && safeEqualStr(bearer, AGENT_TOKEN)) {
      return {
        account_id,
        auth_actor: "agent",
        auth_scopes: [...agent_scopes],
      } satisfies LiteConatUser;
    }

    if (AUTH_TOKEN) {
      const cookieName = getAuthCookieName(socket?.handshake?.headers?.host);
      const cookieValue = cookies[cookieName];
      if (verifyPassword(AUTH_TOKEN, cookieValue)) {
        return {
          account_id,
          auth_actor: "account",
        } satisfies LiteConatUser;
      }
      throw new Error(
        `missing or invalid lite auth cookie '${cookieName}' for conat websocket`,
      );
    }

    if (allowOpenConat || allowUnauthenticatedConat()) {
      return {
        account_id,
        auth_actor: "account",
      } satisfies LiteConatUser;
    }

    throw new Error("conat authentication required");
  };

  const isAllowed: AllowFunction = async ({ user, subject, type }) => {
    if (!user || user.error) return false;

    const liteUser = user as LiteConatUser;
    const userType = getCoCalcUserType(liteUser);
    if (userType === "hub") {
      return true;
    }
    if (userType !== "account" && userType !== "project") {
      return false;
    }

    const userId = getCoCalcUserId(liteUser);

    if (isAgentScoped(liteUser)) {
      if (type === "pub" && subject.startsWith("_INBOX.")) return true;
      const common = checkCommonPermissions({
        user: liteUser,
        userType: "account",
        userId,
        subject,
        type,
      });
      // Agent tokens intentionally cannot call hub.*.api directly.
      if (common != null && !subject.startsWith(`hub.account.${userId}.`)) {
        return common;
      }
      if (
        hasAgentScope(liteUser, "browser_session") &&
        allowAgentServiceSubject({ account_id: userId, subject })
      ) {
        return true;
      }
      return false;
    }

    const common = checkCommonPermissions({
      user: liteUser,
      userType,
      userId,
      subject,
      type,
    });
    if (common != null) {
      return common;
    }
    if (userType === "project") {
      return isProjectSubjectAllowed({ project_id: userId, subject });
    }
    return isAccountAllowed({
      account_id: userId,
      local_project_id: project_id,
      subject,
    });
  };

  return { getUser, isAllowed };
}
