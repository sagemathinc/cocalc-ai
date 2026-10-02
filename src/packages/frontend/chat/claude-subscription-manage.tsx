/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Button, Popconfirm, Typography } from "antd";
import { useState, type ReactNode } from "react";
import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import { CLAUDE_SUBSCRIPTION_KIND } from "@cocalc/util/ai/external-credential-profiles";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { ClaudeSubscriptionConnect } from "./claude-subscription-connect";
import { ClaudeSubscriptionName } from "./claude-subscription-name";

/**
 * Everything you can do with Claude subscriptions under the credential
 * picker: name, disconnect or reconnect the selected one, or connect another.
 * Shared by new-agent and existing-agent settings so they cannot drift.
 */
export function ClaudeSubscriptionManage({
  projectId,
  credentials,
  selectedId,
  disabled,
  onRenamed,
  onDisconnected,
  onConnected,
  children,
}: {
  projectId: string;
  credentials: ExternalCredentialInfo[];
  // The selected subscription's credential ID, when one is selected.
  selectedId?: string;
  disabled?: boolean;
  onRenamed: (id: string, label: string | undefined) => void;
  onDisconnected: (id: string) => void;
  onConnected: (credentialId: string) => Promise<void>;
  // Shown below the account actions (e.g. the connectors choice).
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const selected = credentials.find(
    (row) => row.id === selectedId && row.kind === CLAUDE_SUBSCRIPTION_KIND,
  );
  const disconnect = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const completed = await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.system.revokeExternalCredential({
          id,
          browser_id: webapp_client.browser_id,
        });
      });
      if (completed) onDisconnected(id);
    } catch (err) {
      setError(`${err}`.replace(/^(?:Error:\s*)+/, ""));
    } finally {
      setBusy(false);
    }
  };
  const expiresAt = selected?.metadata?.expires_at;
  return (
    <>
      {typeof expiresAt === "string" && (
        <Typography.Text type="secondary">
          Long-lived token, expires <TimeAgo date={expiresAt} />
        </Typography.Text>
      )}
      <ClaudeSubscriptionConnect
        compact
        links
        projectId={projectId}
        disabled={disabled}
        reconnectCredentialId={selected?.id}
        hasConnection={credentials.some(
          (row) => !row.revoked && row.kind === CLAUDE_SUBSCRIPTION_KIND,
        )}
        onConnected={onConnected}
        leadingActions={
          selected && (
            <ClaudeSubscriptionName
              credential={selected}
              onRenamed={(label) => onRenamed(selected.id, label)}
            />
          )
        }
        trailingActions={
          selectedId && (
            <Popconfirm
              title="Disconnect Claude subscription?"
              description="Blocks new project-tool calls and future turns. Inference already in flight may continue."
              okText="Disconnect"
              okButtonProps={{ danger: true }}
              onConfirm={() => disconnect(selectedId)}
            >
              <Button
                type="link"
                size="small"
                danger
                style={{ padding: 0 }}
                loading={busy}
                disabled={disabled}
              >
                Disconnect
              </Button>
            </Popconfirm>
          )
        }
      />
      {children}
      {error && <div role="alert">Unable to disconnect Claude: {error}</div>}
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
