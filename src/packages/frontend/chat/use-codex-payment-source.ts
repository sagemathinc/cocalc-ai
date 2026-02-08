import { useEffect, useMemo, useState } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";

export function getCodexPaymentSourceShortLabel(
  source: CodexPaymentSourceInfo["source"] | undefined,
): string {
  switch (source) {
    case "subscription":
      return "Subscription";
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
  switch (source) {
    case "subscription":
      return "ChatGPT Subscription";
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
  if (!paymentSource) {
    return "Checking likely payment source for the next Codex turn...";
  }
  const parts = [
    `Likely source for next turn: ${getCodexPaymentSourceLongLabel(paymentSource.source)}.`,
    "Precedence: subscription → workspace API key → account API key → site API key.",
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
