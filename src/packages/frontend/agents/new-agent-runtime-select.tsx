/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Select } from "antd";

export type NewAgentRuntimeKind = "codex-native" | "claude-code" | "acp";

export function NewAgentRuntimeSelect({
  value,
  disabled,
  includeCustom = true,
  onChange,
}: {
  value: NewAgentRuntimeKind;
  disabled?: boolean;
  // The experimental custom harness is not offered on the first-run screen.
  includeCustom?: boolean;
  onChange: (value: NewAgentRuntimeKind) => void;
}) {
  return (
    <Select
      aria-label="Agent runtime"
      variant="borderless"
      value={value}
      disabled={disabled}
      popupMatchSelectWidth={false}
      style={{ minWidth: 0, maxWidth: "100%" }}
      options={[
        { value: "codex-native", label: "Codex" },
        { value: "claude-code", label: "Claude" },
        ...(includeCustom
          ? [{ value: "acp", label: "Custom ACP harness (experimental)" }]
          : []),
      ]}
      onChange={onChange}
    />
  );
}
