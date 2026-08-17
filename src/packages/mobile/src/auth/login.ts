/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { COLORS } from "@cocalc/util/theme";

import {
  redeemLoginChallenge,
  startLoginChallenge,
  waitForLoginApproval,
} from "./challenge";
import { getAuthBootstrap, parseProtocolCompatibility } from "./protocol";
import {
  normalizeSiteUrl,
  rememberMeCookieHeader,
  siteWithBasePath,
} from "./site-url";
import {
  listSiteProfiles,
  saveSessionCredential,
  saveSiteProfile,
  type MobileSiteProfile,
} from "../storage/site-profiles";

const DEBUG_HTTP_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

export async function browserChallengeLogin({
  enteredUrl,
  email,
  signal,
  onState,
}: {
  enteredUrl: string;
  email?: string;
  signal?: AbortSignal;
  onState?: (state: string) => void;
}): Promise<MobileSiteProfile> {
  const site = normalizeSiteUrl(enteredUrl, {
    allowInsecureHosts: __DEV__ ? DEBUG_HTTP_HOSTS : [],
  });
  onState?.("Checking server compatibility…");
  const initialBootstrap = await getAuthBootstrap({ site, signal });
  const compatibility = parseProtocolCompatibility(initialBootstrap);

  onState?.("Starting browser approval…");
  const challenge = await startLoginChallenge({ site, email, signal });
  const approval = waitForLoginApproval({ site, challenge, signal });
  const browser = WebBrowser.openBrowserAsync(challenge.approval_url, {
    presentationStyle: WebBrowser.WebBrowserPresentationStyle.FORM_SHEET,
    controlsColor: COLORS.COCALC_BLUE,
  });
  onState?.("Approve sign-in in the browser…");
  const status = await approval;
  await WebBrowser.dismissBrowser().catch(() => undefined);
  await browser.catch(() => undefined);

  onState?.("Finishing sign-in…");
  const redeemed = await redeemLoginChallenge({
    site,
    challenge,
    status,
    signal,
  });
  const appBasePath =
    compatibility.capabilities?.app_base_path ?? site.app_base_path;
  const homeSite = siteWithBasePath(
    `${redeemed.home_bay_url ?? challenge.home_bay_url ?? site.origin}`,
    appBasePath,
  );
  const cookieHeader = rememberMeCookieHeader(
    appBasePath,
    redeemed.remember_me,
  );
  const confirmed = await getAuthBootstrap({
    site: homeSite,
    cookieHeader,
    signal,
  });
  if (!confirmed.signed_in || confirmed.account_id !== redeemed.account_id) {
    throw new Error(
      "The new session could not be confirmed on the account home bay.",
    );
  }

  const existingProfile = (await listSiteProfiles()).find(
    (profile) =>
      profile.canonical_app_url === site.canonical_app_url &&
      profile.account_id === redeemed.account_id,
  );
  const profile_id = existingProfile?.profile_id ?? Crypto.randomUUID();
  const displayName =
    `${confirmed.display_name ?? redeemed.display_name ?? ""}`.trim() ||
    undefined;
  const profile: MobileSiteProfile = {
    profile_id,
    entered_app_url: site.entered_app_url,
    canonical_app_url: site.canonical_app_url,
    app_base_path: appBasePath,
    account_id: redeemed.account_id,
    email_address:
      `${confirmed.email_address ?? redeemed.email_address ?? ""}`.trim() ||
      undefined,
    display_name: displayName,
    home_bay_id:
      `${confirmed.home_bay_id ?? redeemed.home_bay_id ?? ""}`.trim() ||
      undefined,
    home_bay_url: homeSite.canonical_app_url,
    protocol: compatibility.capabilities,
    last_used_at: new Date().toISOString(),
  };
  await saveSessionCredential(profile_id, {
    remember_me: redeemed.remember_me,
    expire: new Date(redeemed.expire).toISOString(),
  });
  await saveSiteProfile(profile);
  return profile;
}
