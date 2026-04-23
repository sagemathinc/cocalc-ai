/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Modal, Space, Typography } from "antd";
import { useMemo, useState } from "react";
import MembershipPurchaseModal from "@cocalc/frontend/account/membership-purchase-modal";
import { CodexCredentialsPanel } from "@cocalc/frontend/account/codex-credentials-panel";

const { Paragraph, Text } = Typography;

export function isCodexUsageLimitMessage(text?: string): boolean {
  const normalized = `${text ?? ""}`.toLowerCase();
  return (
    normalized.includes("llm usage limit reached") ||
    (normalized.includes("llm usage limit") &&
      normalized.includes("upgrade your membership"))
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
    normalized.includes("please try signing in again")
  ) {
    return {
      kind: "expired-auth",
      title: "Codex authentication expired.",
      description:
        "Sign in again with your ChatGPT Plan or update your OpenAI API key, then retry this message.",
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
        "Connect a ChatGPT Plan or add an OpenAI API key, then retry this message.",
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
  const [membershipOpen, setMembershipOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const authError = useMemo(
    () => classifyCodexAuthErrorMessage(message),
    [message],
  );
  const showUsageLimit = useMemo(
    () => isCodexUsageLimitMessage(message),
    [message],
  );

  if (!showUsageLimit && !authError) return null;

  return (
    <>
      <div style={{ marginTop: 12, marginBottom: 6 }}>
        {authError ? (
          <>
            <Paragraph type="secondary" style={{ marginBottom: 8 }}>
              <Text strong>{authError.title}</Text> {authError.description}
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
              <Text strong>Need more Codex access?</Text> Upgrade here or switch
              this chat to your own ChatGPT Plan or OpenAI API key.
            </Paragraph>
            <Space wrap>
              <Button
                size="small"
                type="primary"
                onClick={() => setMembershipOpen(true)}
              >
                Upgrade membership
              </Button>
              <Button size="small" onClick={() => setSettingsOpen(true)}>
                Open AI settings
              </Button>
            </Space>
          </>
        )}
      </div>
      <MembershipPurchaseModal
        open={membershipOpen}
        onClose={() => setMembershipOpen(false)}
      />
      <Modal
        open={settingsOpen}
        title={
          authError
            ? "Codex Authentication"
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
