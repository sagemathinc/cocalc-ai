/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Popover, Space, Typography, message } from "antd";
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Paragraph } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";

type ActionAssistProps = {
  title?: ReactNode;
  description?: ReactNode;
  cliTitle?: ReactNode;
  cliCommands?: string[];
  cliDisabled?: boolean;
  agentLabel?: ReactNode;
  agentDescription?: ReactNode;
  agentDisabled?: boolean;
  agentDisabledReason?: ReactNode;
  onSendAgent?: () => Promise<void>;
  style?: CSSProperties;
};

export default function ActionAssist({
  title,
  description,
  cliTitle = "CLI",
  cliCommands,
  cliDisabled = false,
  agentLabel = "Agent",
  agentDescription,
  agentDisabled = false,
  agentDisabledReason,
  onSendAgent,
  style,
}: ActionAssistProps) {
  const [sendingAgent, setSendingAgent] = useState(false);
  const commands = (cliCommands ?? []).filter((command) => `${command}`.trim());
  const showCli = commands.length > 0;
  const showAgent = typeof onSendAgent === "function";

  if (!showCli && !showAgent) {
    return null;
  }

  async function sendAgent() {
    if (!onSendAgent) return;
    try {
      setSendingAgent(true);
      await onSendAgent();
      void message.success("Sent to the current agent thread.");
    } catch (err) {
      const text = `${err ?? "Unable to send to agent."}`.trim();
      void message.error(text || "Unable to send to agent.");
      throw err;
    } finally {
      setSendingAgent(false);
    }
  }

  return (
    <div
      style={{
        border: `1px solid ${COLORS.GRAY_L}`,
        borderRadius: "8px",
        padding: "12px",
        background: COLORS.GRAY_LL,
        ...style,
      }}
    >
      {title ? (
        <div
          style={{ fontWeight: 600, marginBottom: description ? "4px" : "8px" }}
        >
          {title}
        </div>
      ) : null}
      {description ? (
        <Paragraph type="secondary" style={{ marginBottom: "10px" }}>
          {description}
        </Paragraph>
      ) : null}
      <Space wrap>
        {showCli ? (
          <Popover
            trigger="click"
            title={cliTitle}
            content={
              <div style={{ maxWidth: 560 }}>
                {commands.map((command) => (
                  <Typography.Paragraph
                    key={command}
                    copyable={{ text: command }}
                    style={{ marginBottom: 8 }}
                  >
                    <code style={{ overflowWrap: "anywhere" }}>{command}</code>
                  </Typography.Paragraph>
                ))}
              </div>
            }
          >
            <Button size="small" disabled={cliDisabled}>
              CLI
            </Button>
          </Popover>
        ) : null}
        {showAgent ? (
          <Button
            size="small"
            loading={sendingAgent}
            disabled={agentDisabled}
            onClick={() => void sendAgent()}
          >
            {agentLabel}
          </Button>
        ) : null}
      </Space>
      {showAgent && (agentDescription || agentDisabledReason) ? (
        <Paragraph
          type="secondary"
          style={{ marginBottom: 0, marginTop: "10px" }}
        >
          {agentDisabled ? agentDisabledReason : agentDescription}
        </Paragraph>
      ) : null}
    </div>
  );
}
