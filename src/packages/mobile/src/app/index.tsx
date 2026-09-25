/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { COLORS } from "@cocalc/util/theme";
import { useCallback, useState } from "react";
import {
  listSiteProfiles,
  type MobileSiteProfile,
} from "../storage/site-profiles";
import { Link, Stack, useFocusEffect } from "expo-router";
import {
  PlatformColor,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { previewEnabled, PREVIEW_PROFILE } from "../preview/fixtures";

export default function WelcomeScreen() {
  const [profiles, setProfiles] = useState<MobileSiteProfile[]>([]);
  const [error, setError] = useState<string>();
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void listSiteProfiles()
        .then((value) => {
          if (active) setProfiles(value);
        })
        .catch((err) => {
          if (active) setError(String(err));
        });
      return () => {
        active = false;
      };
    }, []),
  );
  return (
    <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
      <Stack.Screen options={{ title: "CoCalc" }} />
      <ScrollView contentContainerStyle={styles.container}>
        <Text accessibilityRole="header" style={styles.title}>
          CoCalc on mobile
        </Text>
        <Text style={styles.body}>
          Connect to your CoCalc site and work with your agents.
        </Text>
        {error ? <Text accessibilityRole="alert">{error}</Text> : null}
        {profiles.map((profile) => (
          <Link
            key={profile.profile_id}
            accessibilityRole="button"
            accessibilityLabel={`Open ${profile.display_name ?? profile.email_address ?? profile.account_id} on ${profile.canonical_app_url}`}
            href={
              profile.signed_out_at
                ? "/transport"
                : {
                    pathname: "/agents",
                    params: { profile: profile.profile_id },
                  }
            }
            style={styles.account}
          >
            {profile.display_name ??
              profile.email_address ??
              profile.account_id}
            {"\n"}
            {profile.canonical_app_url}
            {profile.signed_out_at ? "\nSigned out · sign in again" : ""}
          </Link>
        ))}
        {previewEnabled ? (
          <Link
            accessibilityRole="button"
            accessibilityLabel="Open local UI preview"
            href={{ pathname: "/agents", params: { profile: PREVIEW_PROFILE } }}
            style={styles.primaryAction}
          >
            Open local UI preview
          </Link>
        ) : null}
        <Link
          accessibilityRole="button"
          accessibilityLabel="Add or manage CoCalc accounts"
          href="/transport"
          style={styles.primaryAction}
        >
          Add or manage accounts
        </Link>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: PlatformColor("systemBackground"),
  },
  container: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
    gap: 16,
  },
  title: {
    color: PlatformColor("label"),
    fontSize: 34,
    fontWeight: "700",
  },
  body: {
    color: PlatformColor("secondaryLabel"),
    fontSize: 18,
    lineHeight: 26,
  },
  account: {
    padding: 16,
    borderRadius: 12,
    backgroundColor: PlatformColor("secondarySystemBackground"),
    color: PlatformColor("label"),
    fontSize: 18,
  },
  primaryAction: {
    alignSelf: "flex-start",
    overflow: "hidden",
    borderRadius: 10,
    backgroundColor: COLORS.COCALC_BLUE,
    color: COLORS.TOP_BAR.ACTIVE,
    fontSize: 17,
    fontWeight: "600",
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
});
