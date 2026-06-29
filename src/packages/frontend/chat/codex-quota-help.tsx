/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Modal, Space, Typography } from "antd";
import { useMemo, useState } from "react";
import { CodexCredentialsPanel } from "@cocalc/frontend/account/codex-credentials-panel";
import {
  CODEX_USAGE_LABEL,
  CODEX_USAGE_URL,
} from "@cocalc/frontend/account/codex-usage";

const { Paragraph, Text } = Typography;

export function isCodexUsageLimitMessage(text?: string): boolean {
  const normalized = `${text ?? ""}`.toLowerCase();
  return (
    isCodexSiteAiUnavailableMessage(text) ||
    normalized.includes("ai usage limit reached") ||
    normalized.includes("llm usage limit reached") ||
    normalized.includes("you have reached your 5-hour ai usage limit") ||
    normalized.includes("you have reached your 7-day ai usage limit") ||
    ((normalized.includes("ai usage limit") ||
      normalized.includes("llm usage limit")) &&
      normalized.includes("upgrade your membership"))
  );
}

export function isCodexSiteAiUnavailableMessage(text?: string): boolean {
  const normalized = `${text ?? ""}`.toLowerCase();
  return (
    normalized.includes("cocalc ai usage is not included on this site") ||
    normalized.includes("site-provided ai usage is not available") ||
    normalized.includes("site-provided openai access is not available")
  );
}

type CodexAuthErrorPresentation = {
  kind: "expired-auth" | "missing-auth";
  title: string;
  description: string;
  actionLabel: string;
};

export function classifyCodexAuthErrorMessage(
  text?: string,
): CodexAuthErrorPresentation | undefined {
  const normalized = `${text ?? ""}`.toLowerCase();
  if (
    normalized.includes("codex authentication expired") ||
    normalized.includes("token_expired") ||
    normalized.includes("provided authentication token is expired") ||
    normalized.includes("please try signing in again") ||
    normalized.includes("invalidated oauth token") ||
    normalized.includes("identity_edge_internal_error")
  ) {
    return {
      kind: "expired-auth",
      title: "Codex authentication expired.",
      description:
        "Reconnect your ChatGPT Plan or update your OpenAI API key. The failed Codex request can then be submitted again from the message controls.",
      actionLabel: "Sign in again",
    };
  }
  if (
    normalized.includes("codex is not configured") ||
    normalized.includes("missing bearer or basic authentication") ||
    normalized.includes("missing authentication in header")
  ) {
    return {
      kind: "missing-auth",
      title: "Codex is not configured.",
      description:
        "Connect a ChatGPT Plan or add an OpenAI API key. The failed Codex request can then be submitted again from the message controls.",
      actionLabel: "Configure Codex",
    };
  }
  return undefined;
}

export function CodexQuotaHelp({
  message,
  projectId,
}: {
  message?: string;
  projectId?: string;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const authError = useMemo(
    () => classifyCodexAuthErrorMessage(message),
    [message],
  );
  const showUsageLimit = useMemo(
    () => isCodexUsageLimitMessage(message),
    [message],
  );
  const showSiteAiUnavailable = useMemo(
    () => isCodexSiteAiUnavailableMessage(message),
    [message],
  );

  if (!showUsageLimit && !authError) return null;

  return (
    <>
      <div style={{ marginTop: 12, marginBottom: 6 }}>
        {authError ? (
          <>
            <Paragraph type="secondary" style={{ marginBottom: 8 }}>
              {authError.description}
            </Paragraph>
            <Space wrap>
              <Button
                size="small"
                type="primary"
                onClick={() => setSettingsOpen(true)}
              >
                {authError.actionLabel}
              </Button>
            </Space>
          </>
        ) : (
          <>
            <Paragraph type="secondary" style={{ marginBottom: 8 }}>
              {showSiteAiUnavailable ? (
                <>
                  <Text strong>AI is not included with CoCalc membership.</Text>{" "}
                  Sign up for a ChatGPT plan, then connect it in CoCalc AI
                  settings.
                </>
              ) : (
                <>
                  <Text strong>Need more Codex access?</Text> Connect your
                  ChatGPT Plan in AI settings. ChatGPT shows your remaining
                  Codex usage.
                </>
              )}
            </Paragraph>
            <Space wrap>
              {showSiteAiUnavailable ? (
                <Button
                  size="small"
                  href="https://chatgpt.com/pricing"
                  target="_blank"
                  rel="noreferrer"
                >
                  View ChatGPT plans
                </Button>
              ) : null}
              <Button
                size="small"
                type="primary"
                onClick={() => setSettingsOpen(true)}
              >
                Open AI Settings
              </Button>
              {!showSiteAiUnavailable ? (
                <Button
                  size="small"
                  href={CODEX_USAGE_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {CODEX_USAGE_LABEL}
                </Button>
              ) : null}
            </Space>
          </>
        )}
      </div>
      <Modal
        open={settingsOpen}
        title={
          authError
            ? "Codex Authentication"
            : showUsageLimit
              ? "Connect a ChatGPT Plan"
              : "Choose one: ChatGPT Plan or OpenAI API key"
        }
        footer={null}
        onCancel={() => setSettingsOpen(false)}
        width={760}
        destroyOnHidden
      >
        <CodexCredentialsPanel embedded defaultProjectId={projectId} />
      </Modal>
    </>
  );
}
