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

export function CodexQuotaHelp({
  message,
  projectId,
}: {
  message?: string;
  projectId?: string;
}) {
  const [membershipOpen, setMembershipOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const show = useMemo(() => isCodexUsageLimitMessage(message), [message]);

  if (!show) return null;

  return (
    <>
      <div style={{ marginTop: 12, marginBottom: 6 }}>
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
      </div>
      <MembershipPurchaseModal
        open={membershipOpen}
        onClose={() => setMembershipOpen(false)}
      />
      <Modal
        open={settingsOpen}
        title="Choose one: ChatGPT Plan or OpenAI API key"
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
