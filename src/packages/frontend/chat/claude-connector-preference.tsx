/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Checkbox } from "antd";
import { CLAUDE_OAUTH_TOKEN_AUTHENTICATION } from "@cocalc/util/ai/external-credential-profiles";

/**
 * claude.ai connectors need a full sign-in. A long-lived token (the current
 * way to connect) can only run models, so the preference does not apply.
 */
export function claudeConnectorsAvailable(
  credentials: { id: string; metadata?: Record<string, unknown> }[],
  credentialId: string | undefined,
): boolean {
  const credential = credentials.find(({ id }) => id === credentialId);
  return (
    credential?.metadata?.authentication !== CLAUDE_OAUTH_TOKEN_AUTHENTICATION
  );
}

export function ClaudeConnectorPreference({
  enabled,
  onChange,
  disabled,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <Checkbox
        checked={enabled}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      >
        Use my claude.ai connectors
      </Checkbox>
      <details style={{ marginTop: 8 }}>
        <summary>About connectors</summary>
        <p>
          Enabled by default. Claude can use services connected to your Claude
          account, including sending task content to them. Turn this off to
          exclude automatically fetched claude.ai connectors from your next
          turn. It does not disconnect them on claude.ai or disable CoCalc
          project tools. This choice is private to your account and does not
          change a running or queued turn.
        </p>
      </details>
    </div>
  );
}
