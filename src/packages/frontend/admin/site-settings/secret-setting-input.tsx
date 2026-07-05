/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Space, Typography } from "antd";
import type { ChangeEvent, CSSProperties } from "react";
import Password, {
  PasswordTextArea,
} from "@cocalc/frontend/components/password";
import { COLORS } from "@cocalc/util/theme";

export interface SecretSettingInputProps {
  value: string;
  onChange: (value: string) => void;
  isSet?: boolean;
  isClearing?: boolean;
  multiline?: number;
  disabled?: boolean;
  placeholder?: string;
  inputStyle?: CSSProperties;
  storedInputStyle?: CSSProperties;
  onClear?: () => void;
}

export default function SecretSettingInput({
  value,
  onChange,
  isSet,
  isClearing,
  multiline,
  disabled,
  placeholder,
  inputStyle,
  storedInputStyle,
  onClear,
}: SecretSettingInputProps) {
  const isStored = !!isSet && !value && !isClearing;
  const effectivePlaceholder =
    isClearing && !value
      ? "Will clear on save"
      : isStored
        ? "Stored (enter to replace)"
        : placeholder;
  const visibilityToggle = !isStored;
  const effectiveInputStyle = isStored ? storedInputStyle : inputStyle;

  function handleChange(
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) {
    onChange(event.target.value);
  }

  const input =
    multiline != null ? (
      <PasswordTextArea
        rows={isStored ? 1 : multiline}
        autoComplete="off"
        style={{
          ...effectiveInputStyle,
          ...(isStored ? { resize: "vertical" } : {}),
        }}
        value={value}
        placeholder={effectivePlaceholder}
        visibilityToggle={visibilityToggle}
        disabled={disabled}
        onChange={handleChange}
      />
    ) : (
      <Password
        autoComplete="off"
        style={effectiveInputStyle}
        value={value}
        placeholder={effectivePlaceholder}
        visibilityToggle={visibilityToggle}
        disabled={disabled}
        onChange={handleChange}
      />
    );

  return (
    <Space vertical style={{ width: "100%" }}>
      {input}
      {isStored ? (
        <Space>
          <Typography.Text italic style={{ color: COLORS.ANTD_GREEN_D }}>
            Saved. Leave blank to keep the current value.
          </Typography.Text>
          {onClear ? (
            <Button size="small" danger onClick={onClear}>
              Clear
            </Button>
          ) : null}
        </Space>
      ) : null}
      {isClearing ? (
        <Typography.Text type="secondary">Will clear on save.</Typography.Text>
      ) : null}
    </Space>
  );
}
