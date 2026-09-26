/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Checkbox } from "antd";

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
      <details>
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
