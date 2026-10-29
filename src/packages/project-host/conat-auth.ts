import {
  getAddress,
  type AllowFunction,
  type UserFunction,
} from "@cocalc/conat/core/server";
import callHub from "@cocalc/conat/hub/call-hub";
import type { GetTemporaryViewerReadPolicyResponse } from "@cocalc/conat/hub/api/public-directory-shares";
// Project-host auth adapter. Central hub has a sibling adapter at
// src/packages/server/conat/socketio/auth.ts.
// Both adapters share subject-level policy via
// src/packages/conat/auth/subject-policy.ts.
import { agentReplyPrefix } from "@cocalc/conat/auth/agent-reply-prefix";
import {
  checkCommonPermissions,
  extractProjectSubject,
  extractShareFileSubject,
  extractViewerFileSubject,
  getCoCalcUserId,
  getCoCalcUserType,
  isAccountAllowed as isAccountSubjectAllowed,
  isFileServerManagementSubject,
  isPersistControlSubject,
  isProjectAllowed as isProjectSubjectAllowed,
  isProjectCollaboratorGroup,
  type CoCalcUser,
} from "@cocalc/conat/auth/subject-policy";
import { isProjectViewerRole } from "@cocalc/util/project-access";
import { isAcpSubject, parseAcpSubject } from "@cocalc/conat/ai/acp/subjects";
import { verifyProjectHostAuthToken } from "@cocalc/conat/auth/project-host-token";
import {
  isComputerPrincipal,
  type ComputerPrincipal,
} from "@cocalc/conat/computers/principal";
import {
  computerPrincipalAllows,
  computerSubjectRequesterAllows,
  isComputerSubject,
} from "@cocalc/conat/computers/subjects";
import {
  computerStillAllowed,
  isComputerDropped,
  projectServesComputer,
} from "./computers";
import { computersEnabledOnHost } from "./sqlite/computer-access";
import { isProjectHostApiKeySubjectAllowed } from "@cocalc/conat/auth/project-host-api-key-policy";
import { getRow } from "@cocalc/lite/hub/sqlite/database";
import TTL from "@isaacs/ttlcache";
import { getProjectHostAuthPublicKey } from "./auth-public-key";
import {
  HUB_PASSWORD_COOKIE_NAME,
  PROJECT_ID_COOKIE_NAME,
  PROJECT_SECRET_COOKIE_NAME,
} from "@cocalc/backend/auth/cookie-names";
import { conatPassword } from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import { checkAmbientCookieRequest } from "./browser-origin-policy";
import { PROJECT_HOST_BROWSER_SESSION_COOKIE_NAME } from "@cocalc/conat/auth/project-host-browser-session";
import { isValidUUID } from "@cocalc/util/misc";
import { getProject } from "./sqlite/projects";
import { getAccountRevokedBeforeMs } from "./sqlite/account-revocations";
import {
  resolveProjectHostBrowserSessionFromCookieHeader,
  restrictedBrowserSessionTtlSeconds,
} from "./browser-session";
import { getProjectHostManagedEgressBlockedMessage } from "./managed-egress-runtime";
import { getLocalExamAccountProjectId } from "./exam/identity";
import {
  BROWSER_RUNTIME_PRESENCE_AUTH_SCOPE,
  isBrowserRuntimePresenceSubject,
  parseBrowserRuntimePresenceSubject,
} from "@cocalc/conat/project-host/browser-runtime-presence";

const logger = getLogger("project-host:conat-auth");
const MISSING_AUTH_DIAGNOSTIC_INTERVAL_MS = 60_000;
let lastMissingAuthDiagnosticAt = 0;

const authDecisionCache = new TTL<string, boolean>({
  max: 20_000,
  ttl: 60_000,
});

function shouldCacheAuthDecision(subject: string): boolean {
  // Project access can change from collaborator to path-restricted viewer. Do
  // not let a stale positive cache entry keep unrestricted project-host data
  // subjects open after that role change.
  return (
    !isAcpSubject(subject) &&
    !extractProjectSubject(subject) &&
    !extractViewerFileSubject(subject) &&
    !extractShareFileSubject(subject)
  );
}

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

function isTrustedLocalProjectScopedPeer(socket: any): boolean {
  const address = getAddress(socket, {
    strictCloudflareProxy: true,
  });
  return address === "127.0.0.1" || address === "::1";
}

function assertTrustedLocalProjectScopedPeer(socket: any): void {
  if (isTrustedLocalProjectScopedPeer(socket)) {
    return;
  }
  throw new Error(
    "project-scoped auth is only allowed from trusted local addresses",
  );
}

function userFromBearerToken({
  token,
  host_id,
}: {
  token: string;
  host_id: string;
}): CoCalcUser | ComputerPrincipal {
  const claims = verifyProjectHostAuthToken({
    token,
    host_id,
    // Verify-only key: project-host does not get signing capability.
    public_key: getProjectHostAuthPublicKey(),
  });
  if (claims.act === "computer") {
    const { account_id, project_id } = claims.computer!;
    if (!computersEnabledOnHost()) throw new Error("computers are turned off");
    if (isComputerDropped(claims.sub)) throw new Error("computer revoked");
    if (!projectServesComputer(project_id, account_id)) {
      throw new Error(
        "this computer's project isn't here, or has collaborators besides its owner",
      );
    }
    return {
      auth_actor: "computer",
      computer_id: claims.sub,
      computer_account_id: account_id,
      computer_project_id: project_id,
      auth_lease_exp_s: claims.exp,
    };
  }
  if (claims.act === "hub") {
    return { hub_id: claims.sub || "hub" };
  }
  if (claims.api_key) {
    const project = getProject(claims.api_key.project_id);
    const member = project?.users?.[claims.sub];
    const group = typeof member === "string" ? member : member?.group;
    if (
      Number(project?.runtime_lifecycle_revision) !==
        claims.api_key.placement_revision ||
      !isProjectCollaboratorGroup(group)
    ) {
      throw new Error("API key project-host binding is no longer valid");
    }
    return {
      account_id: claims.sub,
      auth_iat_s: claims.iat,
      auth_lease_exp_s: claims.exp,
      auth_api_key: claims.api_key,
    } satisfies CoCalcUser;
  }
  restrictedBrowserSessionTtlSeconds(claims.browser_session_exp_s);
  if (
    isAccountSessionRevoked({
      account_id: claims.sub,
      issued_at_s: claims.iat,
      auth_actor: claims.auth_actor,
    })
  ) {
    throw new Error("session revoked");
  }
  return {
    account_id: claims.sub,
    auth_iat_s: claims.iat,
    auth_actor: claims.auth_actor,
    ...(claims.auth_actor === "agent"
      ? {
          auth_project_id: claims.project_id,
          // replies of its own, not the account's _INBOX.account-<id>; the
          // same for the whole agent session, as on the bay, so refreshing
          // the token does not replace the inbox
          auth_api_key_reply_prefix: agentReplyPrefix(
            claims.sid
              ? [
                  "agent-session",
                  claims.sub,
                  claims.project_id,
                  claims.sid,
                ].join("\0")
              : claims.jti,
          ),
        }
      : {}),
  } satisfies CoCalcUser;
}

function isProjectCollaboratorLocal({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): boolean {
  const row = getRow("projects", JSON.stringify({ project_id }));
  const userEntry = row?.users?.[account_id];
  const group = typeof userEntry === "string" ? userEntry : userEntry?.group;
  return isProjectCollaboratorGroup(group);
}

function isProjectViewerLocal({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): boolean {
  const row = getRow("projects", JSON.stringify({ project_id }));
  const userEntry = row?.users?.[account_id];
  const group = typeof userEntry === "string" ? userEntry : userEntry?.group;
  return isProjectViewerRole(group);
}

async function hasTemporaryViewerGrant({
  host_id,
  account_id,
  project_id,
}: {
  host_id: string;
  account_id: string;
  project_id: string;
}): Promise<boolean> {
  const { getMasterConatClient } = await import("./master-status");
  const client = getMasterConatClient();
  if (!client) {
    return false;
  }
  try {
    const response = (await callHub({
      client,
      host_id,
      name: "publicDirectoryShares.getTemporaryViewerReadPolicy",
      args: [{ account_id, project_id }],
      timeout: 5_000,
    })) as GetTemporaryViewerReadPolicyResponse;
    return (
      response.account_id === account_id &&
      response.project_id === project_id &&
      Array.isArray(response.read_policy?.rules) &&
      response.read_policy.rules.length > 0
    );
  } catch {
    return false;
  }
}

function isAccountUnknownLocally({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): boolean {
  const row = getRow("projects", JSON.stringify({ project_id }));
  return row?.users?.[account_id] == null;
}

// The owning bay's answers for accounts the host's collaborator list does not
// know, kept briefly so that a non-member cannot turn every publish into a bay
// call. A collaborator sync clears them (clearAuthCaches), and an answer is
// used only while the host's list is still the revision it was given against:
// a newer list stored by any path (e.g., another account's bay lookup) voids
// it.
type BayMembershipDecision = {
  member: boolean;
  users_revision: number | null;
};
const bayMembershipDecisions = new TTL<string, BayMembershipDecision>({
  max: 10_000,
  ttl: 30_000,
});
type BayMembershipFlight = {
  account_id: string;
  generation: number;
  promise: Promise<boolean>;
};
const bayMembershipInFlight = new Map<string, BayMembershipFlight>();
const bayMembershipInFlightByAccount = new Map<string, number>();
let bayMembershipRunning = 0;
let bayMembershipGeneration = 0;
const BAY_MEMBERSHIP_TIMEOUT_MS = 5_000;
// Bay requests running at once, for the whole host and for one account. When
// either is full the account is refused at once (and may retry): an account
// cannot queue up requests for many projects.
const BAY_MEMBERSHIP_MAX_IN_FLIGHT = 32;
const BAY_MEMBERSHIP_MAX_IN_FLIGHT_PER_ACCOUNT = 4;

// The host's collaborator list can lag the owning bay. An archived project has
// no local row until it starts again, and a browser that is already connected
// to this host never asks the hub for the project-scoped token whose issue
// syncs the list. So before refusing an account the list does not know at
// all, ask the bay. An account the list knows in another role (a viewer) is
// refused without asking.
function localUsersRevision(project_id: string): number | null {
  const revision = getRow(
    "projects",
    JSON.stringify({ project_id }),
  )?.users_revision;
  return Number.isFinite(revision) ? Number(revision) : null;
}

async function isProjectMemberConfirmedByBay({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<boolean> {
  const key = `${account_id}:${project_id}`;
  const cached = bayMembershipDecisions.get(key);
  if (
    cached != null &&
    cached.users_revision === localUsersRevision(project_id)
  ) {
    return cached.member;
  }
  let flight = bayMembershipInFlight.get(key);
  if (flight == null) {
    const accountInFlight = bayMembershipInFlightByAccount.get(account_id) ?? 0;
    if (
      bayMembershipRunning >= BAY_MEMBERSHIP_MAX_IN_FLIGHT ||
      accountInFlight >= BAY_MEMBERSHIP_MAX_IN_FLIGHT_PER_ACCOUNT
    ) {
      return false;
    }
    flight = startBayMembershipFlight({ key, account_id, project_id });
  }
  const member = await flight.promise;
  if (flight.generation !== bayMembershipGeneration) {
    // A collaborator sync arrived while the bay was asked: the list it stored
    // decides, not the earlier answer.
    return isProjectCollaboratorLocal({ account_id, project_id });
  }
  return member;
}

function startBayMembershipFlight({
  key,
  account_id,
  project_id,
}: {
  key: string;
  account_id: string;
  project_id: string;
}): BayMembershipFlight {
  const generation = bayMembershipGeneration;
  bayMembershipRunning += 1;
  bayMembershipInFlightByAccount.set(
    account_id,
    (bayMembershipInFlightByAccount.get(account_id) ?? 0) + 1,
  );
  const flight: BayMembershipFlight = {
    account_id,
    generation,
    promise: (async () => {
      let member = false;
      try {
        const { confirmProjectMemberWithOwningBay } =
          await import("./acp/project-membership");
        member = await confirmProjectMemberWithOwningBay({
          account_id,
          project_id,
          timeout: BAY_MEMBERSHIP_TIMEOUT_MS,
        });
      } catch (err) {
        logger.debug("could not confirm project membership with the bay", {
          account_id,
          project_id,
          err: `${err}`,
        });
      }
      if (generation === bayMembershipGeneration) {
        bayMembershipDecisions.set(key, {
          member,
          users_revision: localUsersRevision(project_id),
        });
      }
      return member;
    })().finally(() => {
      bayMembershipRunning -= 1;
      const left = (bayMembershipInFlightByAccount.get(account_id) ?? 1) - 1;
      if (left > 0) bayMembershipInFlightByAccount.set(account_id, left);
      else bayMembershipInFlightByAccount.delete(account_id);
      if (bayMembershipInFlight.get(key) === flight) {
        bayMembershipInFlight.delete(key);
      }
    }),
  };
  bayMembershipInFlight.set(key, flight);
  return flight;
}

function clearAuthCaches() {
  authDecisionCache.clear();
  bayMembershipDecisions.clear();
  // Requests already sent still count against the limits until they finish,
  // but nobody joins them: callers after the sync ask again.
  bayMembershipInFlight.clear();
  bayMembershipGeneration += 1;
}

function throwManagedEgressBlocked(account_id: string): never {
  const message =
    getProjectHostManagedEgressBlockedMessage(account_id) ??
    "interactive session traffic is temporarily blocked for this account";
  throw Object.assign(new Error(message), {
    code: 429,
    authFailure: false,
  });
}

function getAccountIssuedAtSeconds(user: any): number {
  const iat = Number(user?.auth_iat_s);
  if (Number.isFinite(iat) && iat > 0) {
    return Math.floor(iat);
  }
  return 0;
}

export function isAccountSessionRevoked({
  account_id,
  issued_at_s,
  auth_actor,
}: {
  account_id: string;
  issued_at_s: number;
  // "agent": an agent's own credential, which a password change leaves alone.
  auth_actor?: string;
}): boolean {
  const revokedBeforeMs = getAccountRevokedBeforeMs(account_id, { auth_actor });
  if (revokedBeforeMs == null) {
    return false;
  }
  return issued_at_s * 1000 <= revokedBeforeMs;
}

export function clearProjectHostConatAuthCaches() {
  clearAuthCaches();
}

export function createProjectHostConatAuth({ host_id }: { host_id: string }): {
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
    if (token) {
      const user = userFromBearerToken({ token, host_id });
      if (isComputerPrincipal(user)) return user;
      if (user.account_id) {
        if (getProjectHostManagedEgressBlockedMessage(user.account_id)) {
          throwManagedEgressBlocked(user.account_id);
        }
      }
      return user;
    }
    const browserSession = resolveProjectHostBrowserSessionFromCookieHeader(
      socket?.handshake?.headers?.cookie,
    );
    if (browserSession) {
      // The browser sends this cookie on websockets opened by any site, and
      // CORS does not apply to websockets.
      if (
        !checkAmbientCookieRequest(
          { headers: socket?.handshake?.headers ?? {} },
          "conat",
        )
      ) {
        throw new Error("cross-site connection refused");
      }
      if (
        getProjectHostManagedEgressBlockedMessage(browserSession.account_id)
      ) {
        throwManagedEgressBlocked(browserSession.account_id);
      }
      if (
        isAccountSessionRevoked({
          account_id: browserSession.account_id,
          issued_at_s: browserSession.iat_s,
        })
      ) {
        throw new Error("session revoked");
      }
      return {
        account_id: browserSession.account_id,
        auth_iat_s: browserSession.iat_s,
        auth_scopes: [BROWSER_RUNTIME_PRESENCE_AUTH_SCOPE],
      } satisfies CoCalcUser;
    }
    const handshakeProjectAuth = readProjectScopedAuth(socket);
    if (handshakeProjectAuth) {
      assertTrustedLocalProjectScopedPeer(socket);
      const row = getProject(handshakeProjectAuth.project_id);
      if (!row?.secret_token) {
        throw new Error("project secret token not configured");
      }
      if (handshakeProjectAuth.project_secret !== row.secret_token) {
        throw new Error("invalid secret token for project");
      }
      return { project_id: handshakeProjectAuth.project_id };
    }
    if (cookies?.[PROJECT_SECRET_COOKIE_NAME] != null) {
      assertTrustedLocalProjectScopedPeer(socket);
      const project_id = cookies?.[PROJECT_ID_COOKIE_NAME];
      if (!project_id || !isValidUUID(project_id)) {
        throw new Error("invalid or missing project_id for project auth");
      }
      const row = getProject(project_id);
      if (!row?.secret_token) {
        throw new Error("project secret token not configured");
      }
      if (cookies[PROJECT_SECRET_COOKIE_NAME] !== row.secret_token) {
        throw new Error("invalid secret token for project");
      }
      return { project_id };
    }
    const now = Date.now();
    if (
      now - lastMissingAuthDiagnosticAt >=
      MISSING_AUTH_DIAGNOSTIC_INTERVAL_MS
    ) {
      lastMissingAuthDiagnosticAt = now;
      logger.warn(
        "project-host conat connection has no valid browser authentication",
        {
          host_id,
          cookie_header_present: !!socket?.handshake?.headers?.cookie,
          browser_session_cookie_present:
            cookies?.[PROJECT_HOST_BROWSER_SESSION_COOKIE_NAME] != null,
        },
      );
    }
    throw new Error("missing project-host bearer token");
  };

  const isAllowed: AllowFunction = async ({ user, subject, type }) => {
    if (user == null || user?.error) {
      return false;
    }
    // A paired computer: its own subjects and replies, while its token,
    // revocation and project still allow it ("" is the server's periodic
    // recheck of the socket itself).
    if (isComputerPrincipal(user)) {
      return (
        computerStillAllowed(user) &&
        (subject === "" || computerPrincipalAllows(user, subject, type))
      );
    }

    const userType = getCoCalcUserType(user);
    if (userType === "hub") {
      // Local internal services authenticate using the system account.
      return true;
    }
    if (isPersistControlSubject(subject)) {
      return false;
    }
    if (user.auth_api_key) {
      const binding = user.auth_api_key;
      const project = getProject(binding.project_id);
      const member = project?.users?.[user.account_id!];
      const group = typeof member === "string" ? member : member?.group;
      return (
        userType === "account" &&
        Date.now() < Number(user.auth_lease_exp_s) * 1000 &&
        Number(project?.runtime_lifecycle_revision) ===
          binding.placement_revision &&
        isProjectCollaboratorGroup(group) &&
        isProjectHostApiKeySubjectAllowed({ binding, subject, type })
      );
    }
    if (isFileServerManagementSubject(subject)) {
      return false;
    }
    if (userType !== "account" && userType !== "project") {
      return false;
    }

    const userId = getCoCalcUserId(user);
    // Computers serve exactly one project: only that project's processes
    // (its secret, or an agent token bound to it) may ask them, and nobody
    // but the computers receives there.
    if (isComputerSubject(subject)) {
      const project_id =
        userType === "project"
          ? userId
          : user.auth_actor === "agent"
            ? user.auth_project_id
            : undefined;
      return computerSubjectRequesterAllows(project_id, subject, type);
    }
    if (user.auth_actor === "agent") {
      if (!user.auth_project_id) return false;
      const projectSubject = extractProjectSubject(subject);
      const viewerSubject = extractViewerFileSubject(subject);
      const shareSubject = extractShareFileSubject(subject);
      if (
        (projectSubject && projectSubject !== user.auth_project_id) ||
        (viewerSubject && viewerSubject.project_id !== user.auth_project_id) ||
        (shareSubject && shareSubject.project_id !== user.auth_project_id)
      ) {
        return false;
      }
      // The account's own subjects are not the agent's, as on the bay
      // (server/conat/socketio/auth.ts).  Decided here, before the decision
      // cache:
      // - Replies: it may publish to any inbox (to answer requests), but only
      //   subscribe to its own reply prefix, not the account's
      //   _INBOX.account-<id>, which carries replies meant for the human.
      // - Neither the account's hub API -- whose embedded handler here knows
      //   the caller only from the subject, so an agent publishing there would
      //   act as its account, in any project the account collaborates on --
      //   nor its account services and streams.
      if (subject.startsWith("_INBOX.")) {
        if (type === "pub") return true;
        const replyPrefix = user.auth_api_key_reply_prefix;
        return (
          !!replyPrefix &&
          (subject === replyPrefix || subject.startsWith(`${replyPrefix}.`))
        );
      }
      if (
        subject.startsWith("hub.") ||
        isAccountSubjectAllowed({ account_id: userId, subject })
      ) {
        return false;
      }
    }
    const examProjectId =
      userType === "account" ? getLocalExamAccountProjectId(userId) : undefined;
    if (
      userType === "account" &&
      isAccountSessionRevoked({
        account_id: userId,
        issued_at_s: getAccountIssuedAtSeconds(user),
        auth_actor: user?.auth_actor,
      })
    ) {
      return false;
    }
    if (isBrowserRuntimePresenceSubject(subject)) {
      const presence = parseBrowserRuntimePresenceSubject(subject);
      return (
        userType === "account" &&
        examProjectId == null &&
        type === "pub" &&
        (user.auth_actor !== "agent" ||
          presence?.project_id === user.auth_project_id) &&
        presence?.account_id === userId &&
        user.auth_scopes?.includes(BROWSER_RUNTIME_PRESENCE_AUTH_SCOPE) ===
          true &&
        isProjectCollaboratorLocal({
          account_id: userId,
          project_id: presence.project_id,
        })
      );
    }
    // (an agent and its account share a user id, but not permissions)
    const cacheKey = `${userType}:${user.auth_actor ?? ""}:${userId}:${type}:${subject}`;
    const cacheable = shouldCacheAuthDecision(subject);
    if (cacheable && authDecisionCache.has(cacheKey)) {
      return authDecisionCache.get(cacheKey)!;
    }

    if (isAcpSubject(subject)) {
      const parsed = parseAcpSubject(subject);
      if (
        userType !== "account" ||
        examProjectId != null ||
        type !== "pub" ||
        parsed == null ||
        (user.auth_actor === "agent" &&
          parsed.project_id !== user.auth_project_id) ||
        (parsed.version === "account-project" && parsed.account_id !== userId)
      ) {
        return false;
      }
      // Legacy subjects are allowed only so the compatibility listener can
      // return a refresh-required error. It never executes ACP work.
      return isProjectCollaboratorLocal({
        account_id: userId,
        project_id: parsed.project_id,
      });
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
    } else if (type === "sub" && subject.startsWith("_INBOX.")) {
      allowed = false;
    } else if (userType === "project") {
      allowed = isProjectSubjectAllowed({ project_id: userId, subject });
    } else if (isAccountSubjectAllowed({ account_id: userId, subject })) {
      allowed = true;
    } else {
      const viewerFileSubject = extractViewerFileSubject(subject);
      if (viewerFileSubject) {
        allowed =
          examProjectId == null &&
          type === "pub" &&
          viewerFileSubject.account_id === userId &&
          (isProjectViewerLocal({
            account_id: userId,
            project_id: viewerFileSubject.project_id,
          }) ||
            (await hasTemporaryViewerGrant({
              host_id,
              account_id: userId,
              project_id: viewerFileSubject.project_id,
            })));
        if (cacheable) {
          authDecisionCache.set(cacheKey, allowed);
        }
        return allowed;
      }
      const shareFileSubject = extractShareFileSubject(subject);
      if (shareFileSubject) {
        allowed =
          examProjectId == null &&
          type === "pub" &&
          shareFileSubject.account_id === userId;
        if (cacheable) {
          authDecisionCache.set(cacheKey, allowed);
        }
        return allowed;
      }
      const project_id = extractProjectSubject(subject);
      if (project_id) {
        allowed =
          (examProjectId == null || examProjectId === project_id) &&
          (isProjectCollaboratorLocal({
            account_id: userId,
            project_id,
          }) ||
            (isAccountUnknownLocally({ account_id: userId, project_id }) &&
              (await isProjectMemberConfirmedByBay({
                account_id: userId,
                project_id,
              }))));
      }
    }

    if (allowed && cacheable) {
      authDecisionCache.set(cacheKey, allowed);
    }
    return allowed;
  };

  return {
    getUser,
    isAllowed,
    clearCaches: clearAuthCaches,
  };
}

export const __test__ = {
  isTrustedLocalProjectScopedPeer,
};

function readProjectScopedAuth(
  socket: any,
): { project_id: string; project_secret: string } | undefined {
  const auth = socket?.handshake?.auth;
  const project_secret =
    typeof auth?.project_secret === "string" ? auth.project_secret.trim() : "";
  const project_id =
    typeof auth?.project_id === "string" ? auth.project_id.trim() : "";
  if (!project_secret && !project_id) {
    return undefined;
  }
  if (!project_id || !isValidUUID(project_id)) {
    throw new Error("invalid or missing project_id for project auth");
  }
  if (!project_secret) {
    throw new Error("missing project_secret for project auth");
  }
  return { project_id, project_secret };
}
