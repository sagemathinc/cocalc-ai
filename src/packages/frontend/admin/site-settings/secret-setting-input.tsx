/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Space, Typography } from "antd";
import type { ChangeEvent, CSSProperties } from "react";
import Password, {
  PasswordTextArea,
} from "@cocalc/frontend/components/password";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export interface SecretSettingInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
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
  id,
  value,
  onChange,
  onBlur,
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
        id={id}
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
        onBlur={onBlur}
      />
    ) : (
      <Password
        id={id}
        autoComplete="off"
        style={effectiveInputStyle}
        value={value}
        placeholder={effectivePlaceholder}
        visibilityToggle={visibilityToggle}
        disabled={disabled}
        onChange={handleChange}
        onBlur={onBlur}
      />
    );

  return (
    <Space vertical style={{ width: "100%" }}>
      {input}
      {isStored ? (
        <Space>
          <Typography.Text italic style={{ color: UI_COLORS.success }}>
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
