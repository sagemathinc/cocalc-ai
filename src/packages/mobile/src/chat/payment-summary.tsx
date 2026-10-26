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
import {
  codexPaymentCredential,
  codexPaymentPreference,
} from "./codex-payment";
import { describeClaudePayment, loadClaudePayment } from "./claude-payment";

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
  thread,
  config,
  revision = 0,
  harness,
  onPress,
}: {
  profile: string;
  project: string;
  thread?: string;
  config?: CodexThreadConfig;
  /** Changes when settings may have changed the agent's payment selection,
   * which is account state that the shared config does not reflect. */
  revision?: number;
  /** A harness agent: Claude Code is paid by its claude-code payment
   * selection; other harnesses by credentials managed in the project. */
  harness?: "claude-code" | "project-managed";
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
        if (harness === "project-managed") {
          if (active) setLabel("Project-managed credentials");
          return;
        }
        if (harness === "claude-code") {
          if (!thread) return;
          const payment = await loadClaudePayment(site.hubApi, project, thread);
          if (active) setLabel(describeClaudePayment(payment));
          return;
        }
        // The subscription is the account's choice for this agent, as at
        // admission; a thread's saved credential counts only when the hub
        // cannot answer.
        const credential_id = await codexPaymentCredential(
          site.hubApi.agent,
          project,
          thread,
          config,
        );
        const source = await site.hubApi.system.getCodexPaymentSource({
          project_id: project,
          preference: codexPaymentPreference(config?.paymentSource) ?? "auto",
          credential_id,
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
    }, [
      profile,
      project,
      thread,
      revision,
      harness,
      config?.paymentSource,
      config?.credentialId,
    ]),
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
