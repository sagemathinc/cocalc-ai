/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import callHub from "@cocalc/conat/hub/call-hub";
import { connect, type Client } from "@cocalc/conat/core/client";
import { initHubApi, type HubApi } from "@cocalc/conat/hub/api";
import { inboxPrefix } from "@cocalc/conat/names";
import {
  ProjectHostClientManager,
  type ProjectHostClientLease,
} from "@cocalc/conat/project-host/client-manager";

import { getAuthBootstrap } from "../auth/protocol";
import { normalizeSiteUrl, rememberMeCookieHeader } from "../auth/site-url";
import {
  deleteSiteSession,
  getSessionCredential,
  getSiteProfile,
  type MobileSessionCredential,
  type MobileSiteProfile,
} from "../storage/site-profiles";

const CONNECT_TIMEOUT_MS = 15_000;

export class SessionExpiredError extends Error {
  constructor(message = "Your CoCalc session has expired. Sign in again.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export interface SiteSession {
  profile: MobileSiteProfile;
  credential: MobileSessionCredential;
  hubClient: Client;
  hubApi: HubApi;
  projectHosts: ProjectHostClientManager;
  close(): void;
}

async function createHubClient({
  profile,
  credential,
}: {
  profile: MobileSiteProfile;
  credential: MobileSessionCredential;
}): Promise<Client> {
  const cookie = rememberMeCookieHeader(
    profile.app_base_path,
    credential.remember_me,
  );
  const client = connect({
    address: profile.home_bay_url,
    inboxPrefix: inboxPrefix({ account_id: profile.account_id }),
    extraHeaders: { Cookie: cookie },
    forceNew: true,
    noCache: true,
    reconnection: true,
  });
  try {
    await client.waitUntilSignedIn({ timeout: CONNECT_TIMEOUT_MS });
    return client;
  } catch (err) {
    client.close();
    throw err;
  }
}

async function createProjectHostClient({
  address,
  account_id,
  bearer_token,
  cookieHeader,
}: {
  address: string;
  account_id: string;
  bearer_token: string;
  cookieHeader?: string;
}): Promise<Client> {
  const client = connect({
    address,
    inboxPrefix: inboxPrefix({ account_id }),
    auth: (callback) => callback({ bearer: bearer_token }),
    ...(cookieHeader ? { extraHeaders: { Cookie: cookieHeader } } : {}),
    forceNew: true,
    noCache: true,
    reconnection: true,
  });
  try {
    await client.waitUntilSignedIn({ timeout: CONNECT_TIMEOUT_MS });
    return client;
  } catch (err) {
    client.close();
    throw err;
  }
}

export async function openSiteSession(profileId: string): Promise<SiteSession> {
  const profile = await getSiteProfile(profileId);
  if (!profile)
    throw new Error("The selected CoCalc profile no longer exists.");
  const credential = await getSessionCredential(profileId);
  if (!credential) throw new SessionExpiredError();
  const expiresAt = new Date(credential.expire).valueOf();
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    await deleteSiteSession(profileId);
    throw new SessionExpiredError();
  }

  const homeSite = normalizeSiteUrl(profile.home_bay_url, {
    allowInsecureHosts:
      new URL(profile.home_bay_url).protocol === "http:"
        ? [new URL(profile.home_bay_url).hostname]
        : [],
  });
  const cookieHeader = rememberMeCookieHeader(
    profile.app_base_path,
    credential.remember_me,
  );
  const bootstrap = await getAuthBootstrap({ site: homeSite, cookieHeader });
  if (!bootstrap.signed_in || bootstrap.account_id !== profile.account_id) {
    await deleteSiteSession(profileId);
    throw new SessionExpiredError(
      "This CoCalc session was revoked or expired.",
    );
  }

  const hubClient = await createHubClient({ profile, credential });
  const call = async ({
    name,
    args,
    timeout,
  }: {
    name: string;
    args?: any[];
    timeout?: number;
  }) =>
    await callHub({
      client: hubClient,
      account_id: profile.account_id,
      name,
      args,
      timeout,
    });
  const hubApi = initHubApi(call);
  const projectHosts = new ProjectHostClientManager({
    account_id: profile.account_id,
    api: hubApi.hosts,
    createClient: (opts) =>
      createProjectHostClient({
        ...opts,
        cookieHeader: opts.local_proxy ? cookieHeader : undefined,
      }),
    resolveAddress: ({ connection, project_id }) => {
      const direct = connection.connect_url?.trim();
      if (direct) return direct;
      if (connection.local_proxy) {
        return `${profile.home_bay_url.replace(/\/+$/, "")}/${project_id}`;
      }
      return;
    },
  });

  return {
    profile,
    credential,
    hubClient,
    hubApi,
    projectHosts,
    close: () => {
      projectHosts.close();
      hubClient.close();
    },
  };
}

export async function openProjectHost(
  session: SiteSession,
  opts: { project_id: string; host_id: string },
): Promise<ProjectHostClientLease> {
  return await session.projectHosts.getClient(opts);
}
