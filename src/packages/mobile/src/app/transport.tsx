/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { COLORS } from "@cocalc/util/theme";
import { router, Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  PlatformColor,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { browserChallengeLogin } from "../auth/login";
import { signOutSiteProfile } from "../auth/sign-out";
import { transportBundleProbe } from "../cocalc/transport-bundle-probe";
import {
  listSiteProfiles,
  type MobileSiteProfile,
} from "../storage/site-profiles";

export default function TransportScreen() {
  const [siteUrl, setSiteUrl] = useState("https://cocalc.ai");
  const [email, setEmail] = useState("");
  const [profiles, setProfiles] = useState<MobileSiteProfile[]>([]);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController>(null);

  useEffect(() => {
    void listSiteProfiles().then(setProfiles);
    return () => abortRef.current?.abort();
  }, []);

  const openProjects = (profileId: string) => {
    router.replace({ pathname: "/projects", params: { profile: profileId } });
  };

  const signIn = async () => {
    setError(undefined);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const profile = await browserChallengeLogin({
        enteredUrl: siteUrl,
        email,
        signal: controller.signal,
        onState: setStatus,
      });
      openProjects(profile.profile_id);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : `${err}`);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setStatus(undefined);
    }
  };

  const signOut = async (profile: MobileSiteProfile) => {
    setError(undefined);
    setStatus("Signing out…");
    try {
      await signOutSiteProfile(profile);
      setProfiles(await listSiteProfiles());
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setStatus(undefined);
    }
  };

  const busy = status != null;
  return (
    <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
      <Stack.Screen options={{ title: "Connect" }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          {profiles.length > 0 ? (
            <View style={styles.section}>
              <Text accessibilityRole="header" style={styles.heading}>
                Accounts
              </Text>
              {profiles.map((profile) => (
                <View key={profile.profile_id} style={styles.profile}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${profile.signed_out_at ? "Sign in again as" : "Continue as"} ${profile.display_name ?? profile.email_address ?? profile.account_id} on ${profile.canonical_app_url}`}
                    disabled={busy}
                    onPress={() => {
                      if (profile.signed_out_at) {
                        setSiteUrl(profile.entered_app_url);
                        setEmail(profile.email_address ?? "");
                      } else {
                        openProjects(profile.profile_id);
                      }
                    }}
                    style={({ pressed }) => [
                      styles.profileMain,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.profileName}>
                      {profile.display_name ??
                        profile.email_address ??
                        profile.account_id}
                    </Text>
                    <Text style={styles.secondary}>
                      {profile.canonical_app_url}
                    </Text>
                    {profile.signed_out_at ? (
                      <Text style={styles.signedOut}>
                        Signed out · sign in again
                      </Text>
                    ) : null}
                  </Pressable>
                  {!profile.signed_out_at ? (
                    <Pressable
                      accessibilityLabel={`Sign out ${profile.display_name ?? profile.email_address ?? profile.account_id}`}
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() => void signOut(profile)}
                      style={styles.signOutButton}
                    >
                      <Text style={styles.signOutText}>Sign out</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}

          <View style={styles.section}>
            <Text accessibilityRole="header" style={styles.heading}>
              Add a CoCalc site
            </Text>
            <Text style={styles.body}>
              Use cocalc.ai, a development server, or a self-hosted Launchpad.
            </Text>
            <Text style={styles.label}>CoCalc site URL</Text>
            <TextInput
              accessibilityLabel="CoCalc site URL"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              keyboardType="url"
              onChangeText={setSiteUrl}
              returnKeyType="next"
              style={styles.input}
              textContentType="URL"
              value={siteUrl}
            />
            <Text style={styles.label}>Email hint (optional)</Text>
            <TextInput
              accessibilityLabel="Email hint (optional)"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              editable={!busy}
              keyboardType="email-address"
              onChangeText={setEmail}
              onSubmitEditing={() => void signIn()}
              returnKeyType="go"
              style={styles.input}
              textContentType="emailAddress"
              value={email}
            />
            {error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            ) : null}
            {status ? (
              <View accessibilityLiveRegion="polite" style={styles.progress}>
                <ActivityIndicator />
                <Text style={styles.secondary}>{status}</Text>
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sign in with browser"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => void signIn()}
              style={({ pressed }) => [
                styles.primaryAction,
                pressed && styles.pressed,
                busy && styles.disabled,
              ]}
            >
              <Text style={styles.primaryActionText}>Sign in with browser</Text>
            </Pressable>
          </View>

          <Text
            accessibilityLabel="CoCalc transport modules bundled"
            style={styles.footnote}
          >
            Native transport ready: {Object.keys(transportBundleProbe).length}
            modules
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: {
    flex: 1,
    backgroundColor: PlatformColor("systemBackground"),
  },
  container: {
    padding: 20,
    gap: 28,
  },
  section: {
    gap: 12,
  },
  heading: {
    color: PlatformColor("label"),
    fontSize: 24,
    fontWeight: "700",
  },
  body: {
    color: PlatformColor("secondaryLabel"),
    fontSize: 17,
    lineHeight: 24,
  },
  label: {
    color: PlatformColor("label"),
    fontSize: 15,
    fontWeight: "600",
  },
  input: {
    borderColor: PlatformColor("separator"),
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    color: PlatformColor("label"),
    backgroundColor: PlatformColor("secondarySystemBackground"),
    fontSize: 17,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  primaryAction: {
    alignItems: "center",
    borderRadius: 10,
    backgroundColor: COLORS.COCALC_BLUE,
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  primaryActionText: {
    color: COLORS.TOP_BAR.ACTIVE,
    fontSize: 17,
    fontWeight: "600",
  },
  profile: {
    alignItems: "center",
    borderColor: PlatformColor("separator"),
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: PlatformColor("secondarySystemBackground"),
    flexDirection: "row",
    overflow: "hidden",
  },
  profileMain: {
    flex: 1,
    gap: 4,
    padding: 14,
  },
  profileName: {
    color: PlatformColor("label"),
    fontSize: 17,
    fontWeight: "600",
  },
  secondary: {
    color: PlatformColor("secondaryLabel"),
    fontSize: 15,
  },
  signOutButton: { minHeight: 44, justifyContent: "center", padding: 12 },
  signOutText: { color: COLORS.BS_RED, fontSize: 14, fontWeight: "600" },
  signedOut: { color: PlatformColor("tertiaryLabel"), fontSize: 13 },
  progress: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  error: {
    color: COLORS.BS_RED,
    fontSize: 15,
    lineHeight: 21,
  },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.72 },
  footnote: {
    color: PlatformColor("tertiaryLabel"),
    fontSize: 12,
    textAlign: "center",
  },
});
