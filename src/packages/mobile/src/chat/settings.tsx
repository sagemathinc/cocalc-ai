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
import type { CodexThreadConfig } from "@cocalc/chat-client";
import type {
  CodexModelCapabilityInfo,
  CodexPaymentSourceInfo,
} from "@cocalc/conat/hub/api/system";
import {
  DEFAULT_CODEX_MODELS,
  DEFAULT_CODEX_MODEL_NAME,
} from "@cocalc/util/ai/codex";
import { getProjectCodexModels } from "../cocalc/codex-models";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { isPreviewProfile, type ConversationClient } from "../preview/fixtures";
import { usePalette } from "../ui/palette";

const catalog: CodexModelCapabilityInfo[] = DEFAULT_CODEX_MODELS.map((m) => ({
  model: m.name,
  displayName: m.name,
  description: m.description ?? "",
  reasoning: m.reasoning ?? [],
  serviceTiers: m.serviceTiers ?? [],
}));

export function ChatSettings({
  profile,
  project,
  thread,
  config,
  client,
  onClose,
}: {
  profile: string;
  project: string;
  thread: string;
  config?: CodexThreadConfig;
  client: ConversationClient;
  onClose: () => void;
}) {
  const colors = usePalette();
  const [draft, setDraft] = useState<CodexThreadConfig>(() => ({
    model: config?.model,
    reasoning: config?.reasoning,
    serviceTier: config?.serviceTier,
    paymentSource: config?.paymentSource,
    credentialId: config?.credentialId,
  }));
  const [source, setSource] = useState<CodexPaymentSourceInfo>();
  const [models, setModels] = useState<CodexModelCapabilityInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    setModels([]);
    void (async () => {
      if (isPreviewProfile(profile)) {
        if (active) {
          setModels(catalog);
          setSource(undefined);
        }
        return;
      }
      const session = await getActiveSiteSession(profile);
      const payment = await session.hubApi.system.getCodexPaymentSource({
        project_id: project,
        preference: draft.paymentSource ?? "auto",
        credential_id:
          draft.paymentSource === "subscription"
            ? draft.credentialId
            : undefined,
      });
      if (!active) return;
      setSource(payment);
      if (payment.unavailableReason || payment.source === "none") {
        throw new Error(
          payment.unavailableReason ||
            "No payment source is configured. Connect a plan or API key in the web account settings.",
        );
      }
      if (payment.source === "subscription") {
        const status = await getProjectCodexModels(
          session,
          project,
          payment.credentialId,
        );
        // Reject a catalog fetched while the account credential was changing.
        const current = await session.hubApi.system.getCodexPaymentSource({
          project_id: project,
          preference: draft.paymentSource ?? "auto",
          credential_id:
            draft.paymentSource === "subscription"
              ? draft.credentialId
              : undefined,
        });
        if (
          current.credentialId !== payment.credentialId ||
          current.subscriptionRevision !== payment.subscriptionRevision ||
          current.source !== payment.source
        )
          throw new Error(
            "Your payment source changed. Close settings and try again.",
          );
        if (!status.models?.length)
          throw new Error(
            status.reason ||
              "Could not load models for your ChatGPT plan. Please try again.",
          );
        if (active) setModels(status.models);
      } else if (active) setModels(catalog);
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
  }, [profile, project, draft.paymentSource, draft.credentialId]);

  const modelName = draft.model ?? DEFAULT_CODEX_MODEL_NAME;
  const model = models.find((m) => m.model === modelName);
  const validSelection =
    !!model &&
    (!draft.reasoning ||
      model.reasoning.some((r) => r.id === draft.reasoning)) &&
    (!draft.serviceTier ||
      model.serviceTiers.some((t) => t.id === draft.serviceTier));
  const save = async () => {
    if (pending.current || loading || !validSelection) return;
    pending.current = true;
    setSaving(true);
    setError(undefined);
    try {
      // Preserve fields not edited here, including working directory and session.
      await client.updateCodexThreadConfig({
        thread_id: thread,
        acp_config: { ...config, ...draft },
      });
      onClose();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const choice = (
    label: string,
    selected: boolean,
    onPress: () => void,
    disabled = false,
  ) => (
    <Pressable
      key={label}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: disabled || saving }}
      disabled={disabled || saving}
      onPress={onPress}
      style={{
        padding: 12,
        minHeight: 44,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: selected ? colors.link : colors.border,
        backgroundColor: colors.inset,
        opacity: disabled ? 0.5 : 1,
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
  return (
    <Modal
      animationType="slide"
      onRequestClose={() => {
        if (!saving) onClose();
      }}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.page }}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 10 }}>
          {heading("Agent settings")}
          <Text style={{ color: colors.secondary }}>
            Changes apply to future turns. A running turn keeps its current
            settings.
          </Text>
          {heading("Payment")}
          {choice(
            "Automatic",
            !draft.paymentSource || draft.paymentSource === "auto",
            () =>
              setDraft({
                ...draft,
                paymentSource: "auto",
                credentialId: undefined,
              }),
          )}
          {!source?.subscriptions?.length &&
            choice(
              "ChatGPT plan",
              draft.paymentSource === "subscription",
              () =>
                setDraft({
                  ...draft,
                  paymentSource: "subscription",
                  credentialId: undefined,
                }),
              !!source && !source.hasSubscription,
            )}
          {choice(
            "CoCalc membership",
            draft.paymentSource === "site-api-key",
            () =>
              setDraft({
                ...draft,
                paymentSource: "site-api-key",
                credentialId: undefined,
              }),
            !!source &&
              !(
                source.hasSiteApiKey &&
                source.siteFundedCodex?.enabled &&
                source.siteAiUsageLimitPositive !== false
              ),
          )}
          {source?.subscriptions?.map((c) =>
            choice(
              `ChatGPT: ${c.label || c.email || c.id}${c.plan ? ` (${c.plan})` : ""}`,
              draft.paymentSource === "subscription" &&
                draft.credentialId === c.id,
              () =>
                setDraft({
                  ...draft,
                  paymentSource: "subscription",
                  credentialId: c.id,
                }),
            ),
          )}
          {source?.hasProjectApiKey &&
            choice(
              "Project API key",
              draft.paymentSource === "project-api-key",
              () =>
                setDraft({
                  ...draft,
                  paymentSource: "project-api-key",
                  credentialId: undefined,
                }),
            )}
          {source?.hasAccountApiKey &&
            choice(
              "Account API key",
              draft.paymentSource === "account-api-key",
              () =>
                setDraft({
                  ...draft,
                  paymentSource: "account-api-key",
                  credentialId: undefined,
                }),
            )}
          {source && (
            <Text style={{ color: colors.secondary }}>
              Currently uses:{" "}
              {
                {
                  subscription: "ChatGPT plan",
                  "project-api-key": "Project API key",
                  "account-api-key": "Account API key",
                  "site-api-key": "CoCalc membership",
                  "shared-home": "Shared credentials",
                  none: "Not configured",
                }[source.source]
              }
            </Text>
          )}
          {loading && (
            <ActivityIndicator accessibilityLabel="Loading available models" />
          )}
          {error && (
            <Text accessibilityRole="alert" style={{ color: colors.danger }}>
              {error}
            </Text>
          )}
          {heading("Model")}
          {!model && !loading && (
            <Text style={{ color: colors.secondary }}>
              Current: {modelName}. Select an available model below.
            </Text>
          )}
          {models.map((m) =>
            choice(m.displayName || m.model, m.model === modelName, () =>
              setDraft({
                ...draft,
                model: m.model,
                reasoning: undefined,
                serviceTier: undefined,
              }),
            ),
          )}
          {heading("Thinking level")}
          {choice(
            "Model default",
            !draft.reasoning,
            () => setDraft({ ...draft, reasoning: undefined }),
            !model,
          )}
          {model?.reasoning
            .filter((r) =>
              ["low", "medium", "high", "extra_high", "max", "ultra"].includes(
                r.id,
              ),
            )
            .map((r) =>
              choice(r.id.replace("_", " "), draft.reasoning === r.id, () =>
                setDraft({
                  ...draft,
                  reasoning: r.id as CodexThreadConfig["reasoning"],
                }),
              ),
            )}
          {model && !validSelection && (
            <Text accessibilityRole="alert" style={{ color: colors.danger }}>
              Choose a thinking level and speed supported by this model, or use
              its defaults.
            </Text>
          )}
          {heading("Speed")}
          {choice(
            "Default speed",
            !draft.serviceTier,
            () => setDraft({ ...draft, serviceTier: undefined }),
            !model,
          )}
          {model?.serviceTiers
            .filter((t) => t.id === "standard" || t.id === "fast")
            .map((t) =>
              choice(t.label, draft.serviceTier === t.id, () =>
                setDraft({
                  ...draft,
                  serviceTier: t.id as CodexThreadConfig["serviceTier"],
                }),
              ),
            )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save agent settings"
            disabled={loading || saving || !validSelection}
            accessibilityState={{
              disabled: loading || saving || !validSelection,
            }}
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
