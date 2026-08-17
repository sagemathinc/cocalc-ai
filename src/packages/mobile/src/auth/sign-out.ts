/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { closeActiveSiteSession } from "../cocalc/session-registry";
import {
  deleteSiteSession,
  getSessionCredential,
  saveSiteProfile,
  type MobileSiteProfile,
} from "../storage/site-profiles";
import { postSiteApi } from "./protocol";
import { normalizeSiteUrl, rememberMeCookieHeader } from "./site-url";

export async function signOutSiteProfile(
  profile: MobileSiteProfile,
): Promise<void> {
  const credential = await getSessionCredential(profile.profile_id);
  closeActiveSiteSession();
  try {
    if (credential) {
      const site = normalizeSiteUrl(profile.home_bay_url, {
        allowInsecureHosts:
          __DEV__ && new URL(profile.home_bay_url).protocol === "http:"
            ? [new URL(profile.home_bay_url).hostname]
            : [],
      });
      await postSiteApi({
        site,
        endpoint: "accounts/sign-out",
        body: { all: false },
        cookieHeader: rememberMeCookieHeader(
          profile.app_base_path,
          credential.remember_me,
        ),
      });
    }
  } catch {
    // Local sign-out is authoritative for the device when the site is offline.
  } finally {
    await deleteSiteSession(profile.profile_id);
    await saveSiteProfile({
      ...profile,
      signed_out_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    });
  }
}
