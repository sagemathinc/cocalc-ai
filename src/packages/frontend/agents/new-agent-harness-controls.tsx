/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Button, Modal, Select, Space, Typography } from "antd";
import { useEffect, useState } from "react";
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
import { ClaudeProjectSecretModal } from "@cocalc/frontend/chat/claude-project-secret-modal";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { discoverNewAgentHarness } from "./discover-new-agent-harness";
import {
  newAgentClaudeCredentialOptions,
  newAgentClaudeCredentialValue,
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
  onConnected: (credentialId: string) => Promise<void>;
  disabled?: boolean;
  assertCurrent: () => void;
}) {
  const [secretsOpen, setSecretsOpen] = useState(false);
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
  const payment =
    options.find((option) => option.value === value)?.label ??
    "Choose payment method";
  const configuration = (
    <Space orientation="vertical" style={{ width: "100%", minWidth: 0 }}>
      <Typography.Text strong>Payment method</Typography.Text>
      <Select
        aria-label="Claude credential"
        value={value}
        disabled={disabled || !credentialsLoaded}
        options={options}
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
      {projectId ? (
        <ClaudeSubscriptionConnect
          compact
          key={`${accountId}:${projectId}`}
          projectId={projectId}
          disabled={disabled}
          hasConnection={credentials.some(
            (row) => row.kind === CLAUDE_SUBSCRIPTION_KIND,
          )}
          onConnected={onConnected}
        />
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
      <Typography.Link
        href={`${appBasePath.replace(/\/$/, "")}/docs/ai/claude-code`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Claude Code setup, security model, and billing
      </Typography.Link>
    </Space>
  );
  return (
    <>
      <HarnessRuntimeControl
        key={JSON.stringify([accountId, projectId, runtime.profile])}
        discoveryKey={JSON.stringify(credential)}
        compact
        configureLabel="Configure Claude Code"
        unavailableLabel={
          !projectId
            ? "Select a project to load models"
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
      <Typography.Text
        type="secondary"
        style={{ overflowWrap: "anywhere", maxWidth: "100%" }}
      >
        {credentialsLoaded ? payment : "Loading payment methods"}
      </Typography.Text>
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
