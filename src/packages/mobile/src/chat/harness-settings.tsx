/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ClaudePaymentSelection } from "@cocalc/util/ai/agent-payment-selection";
import type {
  HarnessSelectControl,
  HarnessSessionControls,
  HarnessSessionSettings,
} from "@cocalc/util/ai/harness-controls";
import type { AcpHarnessRuntime } from "@cocalc/util/ai/runtime";
import { CLAUDE_SUBSCRIPTION_KIND } from "@cocalc/util/ai/external-credential-profiles";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { isPreviewProfile, type ConversationClient } from "../preview/fixtures";
import { usePalette } from "../ui/palette";
import { isClaudeCode } from "./agent-name";
import {
  credentialLabel,
  loadClaudePayment,
  type ClaudePayment,
} from "./claude-payment";

// The value a control currently has for this agent: its saved choice, else
// what the harness last reported.
function controlValue(
  settings: HarnessSessionSettings,
  control: HarnessSelectControl,
  isMode: boolean,
): string {
  return (
    (isMode
      ? settings.modeId
      : settings.configOptions?.find(({ id }) => id === control.id)?.value) ??
    control.currentValue
  );
}

function withValue(
  settings: HarnessSessionSettings,
  control: HarnessSelectControl,
  isMode: boolean,
  value: string,
): HarnessSessionSettings {
  if (isMode) return { ...settings, modeId: value };
  return {
    ...settings,
    configOptions: [
      ...(settings.configOptions ?? []).filter(({ id }) => id !== control.id),
      { id: control.id, value },
    ],
  };
}

const selectionKey = (selection?: ClaudePaymentSelection): string =>
  !selection || selection.mode === "default"
    ? "default"
    : selection.mode === "project-secret"
      ? "project-secret"
      : `${selection.mode}:${selection.credential_id}`;

/** Settings for an ACP harness agent such as Claude Code. */
export function HarnessSettings({
  profile,
  project,
  thread,
  runtime,
  controls,
  client,
  onClose,
}: {
  profile: string;
  project: string;
  thread: string;
  runtime: AcpHarnessRuntime;
  controls?: HarnessSessionControls;
  client: Pick<ConversationClient, "updateHarnessSettings">;
  onClose: () => void;
}) {
  const colors = usePalette();
  const claude = isClaudeCode(runtime);
  const name = claude ? "Claude" : "This agent";
  const [settings, setSettings] = useState<HarnessSessionSettings>(
    runtime.settings ?? {},
  );
  const settingsEdited = useRef(false);
  const [payment, setPayment] = useState<ClaudePayment>();
  const [paymentKey, setPaymentKey] = useState("default");
  const paymentEdited = useRef(false);
  const [loading, setLoading] = useState(claude && !isPreviewProfile(profile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!claude || isPreviewProfile(profile)) return;
    let active = true;
    void (async () => {
      const session = await getActiveSiteSession(profile);
      const loaded = await loadClaudePayment(session.hubApi, project, thread);
      if (!active) return;
      setPayment(loaded);
      if (!paymentEdited.current) setPaymentKey(selectionKey(loaded.selection));
    })()
      .catch((err) => {
        if (active) setError(String(err instanceof Error ? err.message : err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [claude, profile, project, thread]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      // Re-choosing the stored option writes nothing, so preferences this
      // screen does not show (claude_ai_connectors) are kept.
      if (
        paymentEdited.current &&
        payment &&
        paymentKey !== selectionKey(payment.selection) &&
        !isPreviewProfile(profile)
      ) {
        const session = await getActiveSiteSession(profile);
        const [mode, credential_id] = paymentKey.split(/:(.*)/s);
        // "Account default" clears this agent's own choice.
        const selection: ClaudePaymentSelection | null =
          mode === "default"
            ? null
            : mode === "project-secret"
              ? { version: 1, provider: "claude-code", mode: "project-secret" }
              : mode === "account-api-key"
                ? {
                    version: 1,
                    provider: "claude-code",
                    mode: "account-api-key",
                    credential_id,
                  }
                : {
                    version: 1,
                    provider: "claude-code",
                    mode: "account-subscription",
                    credential_id,
                  };
        await session.hubApi.agent.setPaymentSelections({
          targets: [{ project_id: project, thread_id: thread }],
          provider: "claude-code",
          selection,
        });
      }
      if (settingsEdited.current)
        await client.updateHarnessSettings({ thread_id: thread, settings });
      onClose();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  };

  const choice = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable
      key={label}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: saving }}
      disabled={saving}
      onPress={onPress}
      style={{
        padding: 12,
        minHeight: 44,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: selected ? colors.link : colors.border,
        backgroundColor: colors.inset,
      }}
    >
      <Text style={{ color: colors.text }}>
        {selected ? "✓ " : ""}
        {label}
      </Text>
    </Pressable>
  );
  const heading = (text: string) => (
    <Text
      key={`heading-${text}`}
      accessibilityRole="header"
      style={{
        color: colors.text,
        fontSize: 20,
        fontWeight: "600",
        marginTop: 12,
      }}
    >
      {text}
    </Text>
  );
  const pickPayment = (key: string) => {
    paymentEdited.current = true;
    setPaymentKey(key);
  };
  const controlList: { control: HarnessSelectControl; isMode: boolean }[] = [
    ...(controls?.configOptions ?? []).map((control) => ({
      control,
      isMode: false,
    })),
    ...(controls?.mode ? [{ control: controls.mode, isMode: true }] : []),
  ];

  return (
    <Modal
      animationType="slide"
      onRequestClose={() => {
        if (!saving) onClose();
      }}
    >
      <SafeAreaView
        accessibilityViewIsModal
        style={{ flex: 1, backgroundColor: colors.page }}
      >
        <ScrollView contentContainerStyle={{ padding: 20, gap: 10 }}>
          {heading(claude ? "Claude Code settings" : "Agent settings")}
          <Text style={{ color: colors.secondary }}>
            Changes apply to future turns. A running turn keeps its current
            settings.
          </Text>
          {claude && heading("Payment")}
          {claude && loading && (
            <ActivityIndicator accessibilityLabel="Loading Claude credentials" />
          )}
          {claude && payment && (
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel="Payment"
              style={{ gap: 10 }}
            >
              {choice(
                "Account default for Claude agents",
                paymentKey === "default",
                () => pickPayment("default"),
              )}
              {payment.credentials
                .filter((c) => c.kind === CLAUDE_SUBSCRIPTION_KIND)
                .map((c) =>
                  choice(
                    credentialLabel(c),
                    paymentKey === `account-subscription:${c.id}`,
                    () => pickPayment(`account-subscription:${c.id}`),
                  ),
                )}
              {payment.credentials
                .filter((c) => c.kind !== CLAUDE_SUBSCRIPTION_KIND)
                .map((c) =>
                  choice(
                    credentialLabel(c),
                    paymentKey === `account-api-key:${c.id}`,
                    () => pickPayment(`account-api-key:${c.id}`),
                  ),
                )}
              {choice(
                "Project secret ANTHROPIC_API_KEY",
                paymentKey === "project-secret",
                () => pickPayment("project-secret"),
              )}
              {!payment.credentials.length && (
                <Text style={{ color: colors.secondary }}>
                  To use a Claude subscription, connect it in the web app's
                  account settings.
                </Text>
              )}
            </View>
          )}
          {controlList.length === 0 && (
            <Text style={{ color: colors.secondary }}>
              {name} reports its models and other choices when it runs. Send it
              a message, then open settings again.
            </Text>
          )}
          {controlList.flatMap(({ control, isMode }) => [
            heading(control.name),
            <View
              key={`group-${control.id}`}
              accessibilityRole="radiogroup"
              accessibilityLabel={control.name}
              style={{ gap: 10 }}
            >
              {control.options.map((option) =>
                choice(
                  option.name,
                  controlValue(settings, control, isMode) === option.value,
                  () => {
                    settingsEdited.current = true;
                    setSettings(
                      withValue(settings, control, isMode, option.value),
                    );
                  },
                ),
              )}
            </View>,
          ])}
          {error && (
            <Text accessibilityRole="alert" style={{ color: colors.danger }}>
              {error}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save agent settings"
            disabled={saving || loading}
            accessibilityState={{ disabled: saving || loading }}
            onPress={() => void save()}
            style={{ padding: 16 }}
          >
            <Text style={{ color: colors.link }}>
              {saving ? "Saving…" : "Save settings"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel agent settings"
            disabled={saving}
            onPress={onClose}
            style={{ padding: 16 }}
          >
            <Text style={{ color: colors.link }}>Cancel</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
