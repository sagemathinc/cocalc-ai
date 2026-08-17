/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { COLORS } from "@cocalc/util/theme";
import { Link, Stack } from "expo-router";
import { PlatformColor, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function WelcomeScreen() {
  return (
    <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
      <Stack.Screen options={{ title: "CoCalc" }} />
      <View style={styles.container}>
        <Text accessibilityRole="header" style={styles.title}>
          CoCalc on mobile
        </Text>
        <Text style={styles.body}>
          Connect to a CoCalc site, choose a project, and continue an existing
          Codex thread.
        </Text>
        <Link
          accessibilityRole="button"
          accessibilityLabel="Configure a CoCalc site"
          href="/transport"
          style={styles.primaryAction}
        >
          Configure site
        </Link>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: PlatformColor("systemBackground"),
  },
  container: {
    flex: 1,
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
