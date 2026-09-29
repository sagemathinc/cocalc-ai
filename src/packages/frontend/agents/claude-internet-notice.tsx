/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";
import { Alert } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { readHarnessCredentialSelection } from "@cocalc/frontend/chat/harness-credential-selection";
import { useProjectRunQuota } from "@cocalc/frontend/project/use-project-run-quota";
import { UpgradePill } from "./upgrade-pill";

// Same test as the "Internet access blocked" project status.
export function isInternetBlocked(network: unknown): boolean {
  return network === false || network === 0;
}

export function useProjectInternetBlocked(projectId: string): boolean {
  const { runQuota } = useProjectRunQuota(projectId);
  return isInternetBlocked(runQuota?.network);
}

// Claude Code signed in with a subscription or a project secret talks to
// Anthropic from inside the project, so it cannot work there without internet
// access. (Account API keys go through the project host's relay instead.)
export function claudeNeedsProjectInternet(
  credentialMode: string | undefined,
): boolean {
  return credentialMode !== "account-api-key";
}

export function ClaudeInternetNotice() {
  return (
    <Alert
      type="info"
      showIcon
      title="To use Claude Code, please upgrade to any paid membership."
      description="This project does not have internet access, which Claude Code needs to reach Anthropic."
      action={<UpgradePill interactive />}
    />
  );
}

// Shows the notice when the project's internet access is blocked, and reports
// that so the caller can keep Claude from starting a turn that cannot work.
// Mount only with a project.
export function ClaudeProjectInternetNotice({
  projectId,
  onBlockedChange,
}: {
  projectId: string;
  onBlockedChange?: (blocked: boolean) => void;
}) {
  const blocked = useProjectInternetBlocked(projectId);
  useEffect(() => {
    onBlockedChange?.(blocked);
    return () => onBlockedChange?.(false);
  }, [blocked, onBlockedChange]);
  return blocked ? <ClaudeInternetNotice /> : null;
}

// For an existing Claude conversation: uses the thread's credential choice
// (a project secret unless one was chosen).
export function ClaudeThreadInternetNotice({
  projectId,
  threadKey,
}: {
  projectId: string;
  threadKey: string;
}) {
  const accountId = useTypedRedux("account", "account_id");
  const mode =
    readHarnessCredentialSelection({ accountId, projectId, threadKey })?.mode ??
    "project-secret";
  if (!claudeNeedsProjectInternet(mode)) return null;
  return <ClaudeProjectInternetNotice projectId={projectId} />;
}
