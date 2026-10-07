/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Dropdown, Space } from "antd";

import { ComposerPillButton } from "@cocalc/frontend/chat/composer-codex-controls";

const SIGN_IN_WITH_CHATGPT_KEY = "__sign-in-with-chatgpt";

export interface NewAgentCodexPaymentOption {
  value: string;
  label: string;
  disabled?: boolean;
}

// Codex payment source for a new agent. Without a connected ChatGPT plan it
// offers to sign in right here. When no payment source works at all (e.g. on
// a CoCalc Star server, which provides no AI itself) it offers signing in
// with either ChatGPT or Claude: neither provider is a prerequisite.
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
  onUseClaude,
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
  // Switches the new agent to Claude, whose controls offer its own sign-in.
  onUseClaude?: () => void;
}) {
  if (unconfigured) {
    return (
      <Space size={4} wrap>
        <Button size="small" disabled={disabled || loading} onClick={onSignIn}>
          Sign in with ChatGPT
        </Button>
        {onUseClaude && (
          <Button
            size="small"
            disabled={disabled || loading}
            onClick={onUseClaude}
          >
            Sign in with Claude
          </Button>
        )}
      </Space>
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
                {
                  key: SIGN_IN_WITH_CHATGPT_KEY,
                  label: "Sign in with ChatGPT…",
                },
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
