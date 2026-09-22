/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { Pressable, Text } from "react-native";
import type { CodexThreadConfig } from "@cocalc/chat-client";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { isPreviewProfile } from "../preview/fixtures";
import { usePalette } from "../ui/palette";

const labels = {
  subscription: "ChatGPT plan",
  "project-api-key": "Project API key",
  "account-api-key": "Account API key",
  "site-api-key": "CoCalc membership",
  "shared-home": "Shared credentials",
  none: "Not configured",
};

export function PaymentSummary({
  profile,
  project,
  config,
  onPress,
}: {
  profile: string;
  project: string;
  config?: CodexThreadConfig;
  onPress: () => void;
}) {
  const colors = usePalette();
  const [label, setLabel] = useState("Checking…");
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setLabel("Checking…");
      if (isPreviewProfile(profile)) {
        setLabel("Preview · no charge");
        return;
      }
      void (async () => {
        const site = await getActiveSiteSession(profile);
        const source = await site.hubApi.system.getCodexPaymentSource({
          project_id: project,
          preference: config?.paymentSource ?? "auto",
          credential_id:
            config?.paymentSource === "subscription"
              ? config.credentialId
              : undefined,
        });
        const credential = source.subscriptions?.find(
          (c) => c.id === source.credentialId,
        );
        const detail = credential?.label || credential?.email;
        if (active)
          setLabel(
            `${labels[source.source]}${detail ? ` · ${detail}` : ""}${source.unavailableReason ? " · unavailable" : ""}`,
          );
      })().catch(() => {
        if (active) setLabel("Could not check · tap Settings");
      });
      return () => {
        active = false;
      };
    }, [profile, project, config?.paymentSource, config?.credentialId]),
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Payment: ${label}. Change agent settings`}
      onPress={onPress}
      style={{ paddingHorizontal: 12, paddingVertical: 10, minHeight: 44 }}
    >
      <Text style={{ color: colors.secondary }}>Payment: {label}</Text>
    </Pressable>
  );
}
