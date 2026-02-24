import { useEffect, useMemo, useState } from "@cocalc/frontend/app-framework";
import { lite } from "@cocalc/frontend/lite";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";

export function getCodexPaymentSourceShortLabel(
  source: CodexPaymentSourceInfo["source"] | undefined,
): string {
  if (lite) {
    if (source === "subscription") return "ChatGPT Plan";
    if (
      source === "project-api-key" ||
      source === "account-api-key" ||
      source === "site-api-key"
    ) {
      return "OpenAI API Key";
    }
    return "Unconfigured";
  }
  switch (source) {
    case "subscription":
      return "ChatGPT Plan";
    case "project-api-key":
    case "account-api-key":
      return "API Key";
    case "site-api-key":
      return "CoCalc Membership";
    case "shared-home":
      return "Shared Home";
    case "none":
    default:
      return "Unconfigured";
  }
}

export function getCodexPaymentSourceLongLabel(
  source: CodexPaymentSourceInfo["source"] | undefined,
): string {
  if (lite) {
    if (source === "subscription") return "ChatGPT Plan";
    if (
      source === "project-api-key" ||
      source === "account-api-key" ||
      source === "site-api-key"
    ) {
      return "OpenAI API Key";
    }
    if (source === "shared-home") {
      return "Local Codex auth";
    }
    return "Not configured";
  }
  switch (source) {
    case "subscription":
      return "ChatGPT Plan";
    case "project-api-key":
      return "Workspace OpenAI API Key";
    case "account-api-key":
      return "Account OpenAI API Key";
    case "site-api-key":
      return "CoCalc Membership (site OpenAI API key)";
    case "shared-home":
      return "Shared ~/.codex";
    case "none":
    default:
      return "No configured source";
  }
}

export function getCodexPaymentSourceTooltip(
  paymentSource?: CodexPaymentSourceInfo,
): string {
  if (lite) {
    if (!paymentSource) {
      return "Checking local Codex configuration...";
    }
    switch (paymentSource.source) {
      case "subscription":
        return "Codex will use your ChatGPT Plan.";
      case "project-api-key":
      case "account-api-key":
      case "site-api-key":
        return "Codex will use your OpenAI API key.";
      case "shared-home":
        return "Codex will use local auth from ~/.codex.";
      case "none":
      default:
        return "Configure either a ChatGPT Plan or an OpenAI API key.";
    }
  }
  if (!paymentSource) {
    return "Checking likely payment source for the next Codex turn...";
  }
  const parts = [
    `Likely source for next turn: ${getCodexPaymentSourceLongLabel(paymentSource.source)}.`,
    "Precedence: ChatGPT Plan → Workspace OpenAI API key → Account OpenAI API key → Site OpenAI API key.",
  ];
  if (paymentSource.hasSubscription) {
    parts.push("A ChatGPT subscription is connected.");
  }
  return parts.join(" ");
}

export function useCodexPaymentSource({
  projectId,
  enabled = true,
  pollMs = 60_000,
}: {
  projectId?: string;
  enabled?: boolean;
  pollMs?: number;
}) {
  const [paymentSource, setPaymentSource] = useState<
    CodexPaymentSourceInfo | undefined
  >(undefined);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [refreshToken, setRefreshToken] = useState<number>(0);

  const refresh = () => setRefreshToken((x) => x + 1);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const result =
          await webapp_client.conat_client.hub.system.getCodexPaymentSource({
            project_id: projectId?.trim() || undefined,
          });
        if (cancelled) return;
        setPaymentSource(result as CodexPaymentSourceInfo);
        setError("");
      } catch (err) {
        if (cancelled) return;
        setError(`${err}`);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [enabled, projectId, refreshToken]);

  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(
      () => {
        setRefreshToken((x) => x + 1);
      },
      Math.max(10_000, pollMs),
    );
    return () => clearInterval(interval);
  }, [enabled, pollMs]);

  const isSiteBilled = paymentSource?.source === "site-api-key";

  const shortLabel = useMemo(
    () => getCodexPaymentSourceShortLabel(paymentSource?.source),
    [paymentSource?.source],
  );

  const tooltip = useMemo(
    () => getCodexPaymentSourceTooltip(paymentSource),
    [paymentSource],
  );

  return {
    paymentSource,
    loading,
    error,
    refresh,
    isSiteBilled,
    shortLabel,
    tooltip,
  };
}
