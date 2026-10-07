/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Dropdown } from "antd";

import { ComposerPillButton } from "@cocalc/frontend/chat/composer-codex-controls";

const SIGN_IN_WITH_CHATGPT_KEY = "__sign-in-with-chatgpt";

export interface NewAgentCodexPaymentOption {
  value: string;
  label: string;
  disabled?: boolean;
}

// Codex payment source for a new agent. Without a connected ChatGPT plan it
// offers to sign in right here; when no payment source works at all (e.g. on
// a CoCalc Star server, which provides no AI itself) that is the only control.
export function NewAgentCodexPaymentControl({
  options,
  selectedValue,
  selectedLabel,
  signInAvailable,
  unconfigured,
  disabled,
  loading,
  onSelect,
  onSignIn,
}: {
  options: NewAgentCodexPaymentOption[];
  selectedValue: string;
  selectedLabel: string;
  signInAvailable: boolean;
  unconfigured: boolean;
  disabled: boolean;
  loading: boolean;
  onSelect: (value: string) => void;
  onSignIn: () => void;
}) {
  if (unconfigured) {
    return (
      <Button size="small" disabled={disabled || loading} onClick={onSignIn}>
        Sign in with ChatGPT
      </Button>
    );
  }
  return (
    <Dropdown
      menu={{
        items: [
          ...options.map(({ value, label, disabled }) => ({
            key: value,
            label,
            disabled,
          })),
          ...(signInAvailable
            ? [
                { type: "divider" as const },
                { key: SIGN_IN_WITH_CHATGPT_KEY, label: "Sign in with ChatGPT…" },
              ]
            : []),
        ],
        selectedKeys: [selectedValue],
        onClick: ({ key }) => {
          if (key === SIGN_IN_WITH_CHATGPT_KEY) {
            onSignIn();
          } else {
            onSelect(key);
          }
        },
      }}
      trigger={["click"]}
    >
      <ComposerPillButton
        aria-label={`Change payment source. Current source: ${selectedLabel}`}
        disabled={disabled || loading}
        style={{
          maxWidth: 120,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {selectedLabel}
      </ComposerPillButton>
    </Dropdown>
  );
}
