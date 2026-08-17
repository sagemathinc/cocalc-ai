/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

import type { ClientProtocolCapabilities } from "@cocalc/util/client-capabilities";

export interface MobileSiteProfile {
  profile_id: string;
  entered_app_url: string;
  canonical_app_url: string;
  app_base_path: string;
  account_id: string;
  email_address?: string;
  display_name?: string;
  home_bay_id?: string;
  home_bay_url: string;
  protocol?: ClientProtocolCapabilities;
  last_used_at: string;
  signed_out_at?: string;
}

export interface MobileSessionCredential {
  remember_me: string;
  expire: string;
}

const PROFILES_KEY = "cocalc.mobile.site-profiles.v1";
const SELECTED_PROFILE_KEY = "cocalc.mobile.selected-profile.v1";
const CREDENTIAL_PREFIX = "cocalc.mobile.session.v1.";

function credentialKey(profileId: string): string {
  return `${CREDENTIAL_PREFIX}${profileId}`;
}

function isProfile(value: unknown): value is MobileSiteProfile {
  const profile = value as Partial<MobileSiteProfile> | undefined;
  return !!(
    profile &&
    typeof profile.profile_id === "string" &&
    typeof profile.canonical_app_url === "string" &&
    typeof profile.account_id === "string" &&
    typeof profile.home_bay_url === "string"
  );
}

export async function listSiteProfiles(): Promise<MobileSiteProfile[]> {
  const raw = await AsyncStorage.getItem(PROFILES_KEY);
  if (!raw) return [];
  try {
    const values = JSON.parse(raw);
    return Array.isArray(values) ? values.filter(isProfile) : [];
  } catch {
    return [];
  }
}

export async function getSiteProfile(
  profileId: string,
): Promise<MobileSiteProfile | undefined> {
  return (await listSiteProfiles()).find(
    (profile) => profile.profile_id === profileId,
  );
}

export async function saveSiteProfile(
  profile: MobileSiteProfile,
): Promise<void> {
  const profiles = await listSiteProfiles();
  const next = profiles.filter(
    (existing) =>
      existing.profile_id !== profile.profile_id &&
      !(
        existing.canonical_app_url === profile.canonical_app_url &&
        existing.account_id === profile.account_id
      ),
  );
  next.unshift(profile);
  await AsyncStorage.multiSet([
    [PROFILES_KEY, JSON.stringify(next)],
    [SELECTED_PROFILE_KEY, profile.profile_id],
  ]);
}

export async function getSelectedProfileId(): Promise<string | undefined> {
  return (await AsyncStorage.getItem(SELECTED_PROFILE_KEY)) ?? undefined;
}

export async function saveSessionCredential(
  profileId: string,
  credential: MobileSessionCredential,
): Promise<void> {
  await SecureStore.setItemAsync(
    credentialKey(profileId),
    JSON.stringify(credential),
    { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
  );
}

export async function getSessionCredential(
  profileId: string,
): Promise<MobileSessionCredential | undefined> {
  const raw = await SecureStore.getItemAsync(credentialKey(profileId));
  if (!raw) return;
  try {
    const credential = JSON.parse(raw) as Partial<MobileSessionCredential>;
    if (
      typeof credential.remember_me !== "string" ||
      typeof credential.expire !== "string"
    ) {
      return;
    }
    return credential as MobileSessionCredential;
  } catch {
    return;
  }
}

export async function deleteSiteSession(profileId: string): Promise<void> {
  await SecureStore.deleteItemAsync(credentialKey(profileId));
}
