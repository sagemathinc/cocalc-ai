/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space } from "antd";
import { useRef, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { ClaudeSubscriptionConnect } from "./claude-subscription-connect";
import {
  readHarnessCredentialSelection,
  writeHarnessCredentialSelection,
} from "./harness-credential-selection";

/**
 * Whether a failed Claude turn failed because its subscription sign-in
 * expired: Claude Code reports "Failed to authenticate: OAuth session expired
 * and could not be refreshed", and CoCalc's own guidance for ACP sign-in
 * errors asks to reconnect the subscription.
 */
export function isClaudeSignInExpired(text: string): boolean {
  const value = `${text ?? ""}`;
  return (
    (/Failed to authenticate\b/i.test(value) &&
      /\b(OAuth|token|expired|refresh|sign[- ]?in|log[- ]?in)/i.test(value)) ||
    /reconnect your Claude subscription/i.test(value)
  );
}

/** The thread's Claude subscription credential, if it uses one. */
export function useClaudeSubscriptionCredentialId(
  projectId: string | undefined,
  threadKey: string | undefined,
): string | undefined {
  const accountId = useTypedRedux("account", "account_id");
  if (!projectId || !threadKey) return;
  const selection = readHarnessCredentialSelection({
    accountId,
    projectId,
    threadKey,
  });
  return selection?.mode === "account-subscription"
    ? selection.credentialId
    : undefined;
}

export function ClaudeSignInRecovery({
  projectId,
  threadKey,
  credentialId,
  details,
  onRetry,
}: {
  projectId: string;
  threadKey: string;
  credentialId: string;
  details: string;
  // Resend the failed request; omitted when it cannot be retried.
  onRetry?: () => Promise<void>;
}) {
  const accountId = useTypedRedux("account", "account_id");
  const [reconnected, setReconnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  async function retry() {
    if (!onRetry || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onRetry();
    } catch {
      setError("We couldn't retry this request. Please send it again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <Alert
      type="warning"
      showIcon
      title="Your Claude sign-in expired."
      description={
        <Space orientation="vertical" style={{ width: "100%" }}>
          <div role="status" aria-live="polite">
            {reconnected
              ? onRetry
                ? "Claude is reconnected. Your original request is ready to retry."
                : "Claude is reconnected. Send your request again."
              : "Reconnect your Claude subscription to continue."}
          </div>
          {!reconnected && (
            <ClaudeSubscriptionConnect
              compact
              reconnectOnly
              hasConnection
              projectId={projectId}
              reconnectCredentialId={credentialId}
              onConnected={(connectedId) => {
                const current = readHarnessCredentialSelection({
                  accountId,
                  projectId,
                  threadKey,
                });
                writeHarnessCredentialSelection({
                  accountId,
                  projectId,
                  threadKey,
                  credential: {
                    version: 1,
                    provider: "anthropic",
                    mode: "account-subscription",
                    credentialId: connectedId,
                    ...(current?.mode === "account-subscription" &&
                    current.claudeAiConnectors === false
                      ? { claudeAiConnectors: false }
                      : {}),
                  },
                });
                setReconnected(true);
              }}
            />
          )}
          {reconnected && onRetry && (
            <Button type="primary" loading={busy} onClick={() => void retry()}>
              Retry request
            </Button>
          )}
          {error && <div role="alert">{error}</div>}
          <details>
            <summary>Technical details</summary>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {details}
            </pre>
          </details>
        </Space>
      }
    />
  );
}
