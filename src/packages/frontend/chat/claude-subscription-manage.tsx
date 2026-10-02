/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Button, Popconfirm } from "antd";
import { useState, type ReactNode } from "react";
import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import { CLAUDE_SUBSCRIPTION_KIND } from "@cocalc/util/ai/external-credential-profiles";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { webapp_client } from "@cocalc/frontend/webapp-client";
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
  // Shown after the name, before the account actions (e.g. connectors).
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
  return (
    <>
      {selected && (
        <ClaudeSubscriptionName
          credential={selected}
          onRenamed={(label) => onRenamed(selected.id, label)}
        />
      )}
      {children}
      {selectedId && (
        <Popconfirm
          title="Disconnect Claude subscription?"
          description="Blocks new project-tool calls and future turns. Inference already in flight may continue."
          okText="Disconnect"
          okButtonProps={{ danger: true }}
          onConfirm={() => disconnect(selectedId)}
        >
          <Button danger loading={busy} disabled={disabled}>
            Disconnect Claude subscription
          </Button>
        </Popconfirm>
      )}
      <ClaudeSubscriptionConnect
        compact
        projectId={projectId}
        disabled={disabled}
        reconnectCredentialId={selected?.id}
        hasConnection={credentials.some(
          (row) => !row.revoked && row.kind === CLAUDE_SUBSCRIPTION_KIND,
        )}
        onConnected={onConnected}
      />
      {error && <div role="alert">Unable to disconnect Claude: {error}</div>}
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
