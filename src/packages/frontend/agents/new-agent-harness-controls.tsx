/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Button, Modal, Select, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import type { AcpHarnessCredential } from "@cocalc/util/ai/runtime";
import type { HarnessSessionSettings } from "@cocalc/util/ai/harness-controls";
import { CLAUDE_SUBSCRIPTION_KIND } from "@cocalc/util/ai/external-credential-profiles";
import {
  claudeCredentialTrustWarning,
  HarnessProfileFields,
  HarnessRuntimeControl,
  harnessRuntimeFromDraft,
  qualifiedHarnessRuntime,
} from "@cocalc/frontend/chat/harness-profile";
import type { HarnessProfileDraft } from "@cocalc/frontend/chat/harness-profile";
import { ClaudeSubscriptionConnect } from "@cocalc/frontend/chat/claude-subscription-connect";
import { ClaudeSubscriptionManage } from "@cocalc/frontend/chat/claude-subscription-manage";
import { ClaudeProjectSecretModal } from "@cocalc/frontend/chat/claude-project-secret-modal";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { DocsLink } from "@cocalc/frontend/docs/link";
import {
  ClaudeConnectorPreference,
  claudeConnectorsAvailable,
} from "@cocalc/frontend/chat/claude-connector-preference";
import { useProjectSecrets } from "@cocalc/frontend/project/use-project-secrets";
import { discoverNewAgentHarness } from "./discover-new-agent-harness";
import {
  newAgentClaudeCredentialOptions,
  newAgentClaudeCredentialValue,
  preferredClaudeCredential,
} from "./claude-credential-options";

export function NewAgentClaudeControls({
  accountId,
  projectId,
  projectHome,
  cwd,
  settings,
  onSettings,
  credential,
  credentials,
  credentialsLoaded,
  onCredential,
  onCredentials,
  onConnected,
  disabled,
  assertCurrent,
}: {
  accountId?: string;
  projectId?: string;
  projectHome: string;
  cwd: string;
  settings: HarnessSessionSettings;
  onSettings: (settings: HarnessSessionSettings) => void;
  credential: AcpHarnessCredential;
  credentials: ExternalCredentialInfo[];
  credentialsLoaded: boolean;
  onCredential: (credential: AcpHarnessCredential) => void;
  // Local update after a subscription is renamed or disconnected.
  onCredentials: (
    update: (rows: ExternalCredentialInfo[]) => ExternalCredentialInfo[],
  ) => void;
  onConnected: (credentialId: string) => Promise<void>;
  disabled?: boolean;
  assertCurrent: () => void;
}) {
  const [secretsOpen, setSecretsOpen] = useState(false);
  const configureButton = useRef<HTMLButtonElement>(null);
  const { secrets } = useProjectSecrets(projectId ?? "");
  const secretMetadata = (secrets as any)?.toJS?.() ?? secrets;
  const validDirectory = cwd.startsWith("/");
  const runtime = qualifiedHarnessRuntime(
    "claude-code",
    validDirectory ? cwd : projectHome || "/home/user",
    settings,
  );
  const scope = JSON.stringify([
    accountId,
    projectId,
    runtime.profile,
    credential,
    validDirectory,
  ]);
  const [readyScope, setReadyScope] = useState("");
  useEffect(() => {
    // Directory edits must not launch a temporary controller on every keystroke.
    const timer = setTimeout(() => setReadyScope(scope), 300);
    return () => clearTimeout(timer);
  }, [scope]);
  const options = newAgentClaudeCredentialOptions(credentials);
  const value = newAgentClaudeCredentialValue(credential);
  const hasSubscription = credentials.some(
    (row) => !row.revoked && row.kind === CLAUDE_SUBSCRIPTION_KIND,
  );
  // Only known-missing setup is onboarding. Unknown metadata or configured
  // credentials must retain the normal discovery/error path.
  const needsConnection =
    !!projectId &&
    validDirectory &&
    credentialsLoaded &&
    credential.mode === "project-secret" &&
    !hasSubscription &&
    secretMetadata != null &&
    !secretMetadata.some(
      (secret: { name: string }) => secret.name === "ANTHROPIC_API_KEY",
    );
  const unavailableCredential =
    credentialsLoaded && !options.some((option) => option.value === value);
  const payment =
    newAgentClaudeCredentialOptions(credentials, true).find(
      (option) => option.value === value,
    )?.label ?? "Choose payment method";
  const configuration = (
    <Space orientation="vertical" style={{ width: "100%", minWidth: 0 }}>
      <Typography.Text strong>Payment method</Typography.Text>
      <Select
        aria-label="Claude credential"
        value={value}
        disabled={disabled || !credentialsLoaded}
        options={
          unavailableCredential
            ? [
                { value, label: "Unavailable connection", disabled: true },
                ...options,
              ]
            : options
        }
        style={{ width: "100%" }}
        popupMatchSelectWidth={false}
        onChange={(next: string) => {
          const mode = next.startsWith("account-subscription:")
            ? "account-subscription"
            : next.startsWith("account-api-key:")
              ? "account-api-key"
              : "project-secret";
          onCredential(
            mode === "project-secret"
              ? { version: 1, provider: "anthropic", mode }
              : {
                  version: 1,
                  provider: "anthropic",
                  mode,
                  credentialId: next.slice(mode.length + 1),
                },
          );
        }}
      />
      {unavailableCredential && (
        <div role="alert">
          The previously selected Claude connection is unavailable or revoked.
          Choose an existing connection above or connect a subscription.
        </div>
      )}
      {projectId ? (
        <ClaudeSubscriptionManage
          key={`${accountId}:${projectId}`}
          projectId={projectId}
          credentials={credentials}
          selectedId={
            credential.mode === "account-subscription"
              ? credential.credentialId
              : undefined
          }
          disabled={disabled}
          onRenamed={(id, label) =>
            onCredentials((rows) =>
              rows.map((row) => {
                if (row.id !== id) return row;
                const metadata = { ...row.metadata };
                if (label) metadata.label = label;
                else delete metadata.label;
                return { ...row, metadata };
              }),
            )
          }
          onDisconnected={(id) => {
            const remaining = credentials.filter((row) => row.id !== id);
            onCredentials((rows) => rows.filter((row) => row.id !== id));
            // Fall back to another subscription, never to the project secret:
            // with none left, the user chooses (connect or pick a key).
            const next = preferredClaudeCredential(undefined, remaining);
            if (next.mode !== "project-secret") onCredential(next);
          }}
          onConnected={onConnected}
        >
          {credential.mode === "account-subscription" &&
            claudeConnectorsAvailable(credentials, credential.credentialId) && (
              <ClaudeConnectorPreference
                enabled={credential.claudeAiConnectors !== false}
                disabled={disabled}
                onChange={(enabled) =>
                  onCredential({ ...credential, claudeAiConnectors: enabled })
                }
              />
            )}
        </ClaudeSubscriptionManage>
      ) : (
        <Typography.Text>
          Select a project before connecting Claude Code or loading model
          options.
        </Typography.Text>
      )}
      {projectId && credential.mode === "project-secret" && (
        <Button
          disabled={disabled}
          onClick={() => setSecretsOpen(true)}
          style={{ maxWidth: "100%", height: "auto", whiteSpace: "normal" }}
        >
          Set ANTHROPIC_API_KEY project secret
        </Button>
      )}
      <details>
        <summary>Connection and credential details</summary>
        <p>
          {claudeCredentialTrustWarning(
            credential.mode === "account-subscription" ||
              credential.mode === "account-api-key"
              ? credential.mode
              : "project-secret",
          )}
        </p>
      </details>
      <DocsLink projectId={projectId} slug="ai/claude-code">
        Claude Code setup, security model, and billing
      </DocsLink>
    </Space>
  );
  return (
    <>
      <HarnessRuntimeControl
        key={JSON.stringify([accountId, projectId, runtime.profile])}
        discoveryKey={JSON.stringify([credential, needsConnection])}
        compact
        configureLabel="Configure Claude Code"
        configureButtonRef={configureButton}
        discoveryPending={
          !!projectId &&
          validDirectory &&
          (!credentialsLoaded || readyScope !== scope)
        }
        inlineSetup={
          needsConnection && projectId ? (
            <ClaudeSubscriptionConnect
              key={`${accountId}:${projectId}`}
              modal
              compact
              projectId={projectId}
              disabled={disabled}
              onConnected={async (credentialId) => {
                const trigger = configureButton.current;
                await onConnected(credentialId);
                assertCurrent();
                // Successful setup removes the modal's original trigger.
                if (
                  trigger === configureButton.current &&
                  trigger?.isConnected
                ) {
                  trigger.focus();
                }
              }}
            />
          ) : undefined
        }
        inlinePayment={
          needsConnection
            ? undefined
            : credentialsLoaded
              ? payment
              : "Loading payment"
        }
        unavailableLabel={
          !projectId
            ? "Select a project to load models"
            : unavailableCredential
              ? "Choose a Claude connection"
              : !validDirectory
                ? "Choose an absolute working directory"
                : "Waiting for model options"
        }
        configuration={configuration}
        runtime={runtime}
        disabled={disabled}
        onSettings={onSettings}
        onDiscover={
          projectId &&
          credentialsLoaded &&
          !needsConnection &&
          !unavailableCredential &&
          !disabled &&
          validDirectory &&
          readyScope === scope
            ? () =>
                discoverNewAgentHarness({
                  projectId,
                  projectHome,
                  runtime,
                  credential,
                  assertCurrent,
                })
            : undefined
        }
      />
      {projectId && secretsOpen && (
        <ClaudeProjectSecretModal
          open
          projectId={projectId}
          onClose={() => setSecretsOpen(false)}
          warning={claudeCredentialTrustWarning("project-secret")}
        />
      )}
    </>
  );
}

export function NewAgentAcpControls({
  draft,
  onChange,
  cwd,
  disabled,
  onCreate,
  createDisabled,
}: {
  draft: HarnessProfileDraft;
  onChange: (draft: HarnessProfileDraft) => void;
  cwd: string;
  disabled?: boolean;
  onCreate: () => void;
  createDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  let configured = false;
  try {
    harnessRuntimeFromDraft(draft, cwd);
    configured = true;
  } catch {
    /* Incomplete draft. */
  }
  return (
    <>
      <Button
        type={configured ? "text" : "primary"}
        size="small"
        disabled={disabled}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Configure ACP harness
      </Button>
      <Modal
        open={open}
        title="Configure ACP harness"
        footer={null}
        onCancel={() => setOpen(false)}
        modalRender={(modal) => <KeyboardBoundary>{modal}</KeyboardBoundary>}
        styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <HarnessProfileFields
            value={draft}
            onChange={onChange}
            disabled={disabled}
          />
          <Button disabled={disabled || createDisabled} onClick={onCreate}>
            Create and configure first
          </Button>
          <Typography.Text type="secondary">
            Create without starting a turn, then load model and mode options.
            Any prompt above is kept as a draft.
          </Typography.Text>
        </Space>
      </Modal>
    </>
  );
}
