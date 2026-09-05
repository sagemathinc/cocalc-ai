/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { DesktopOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import { Popover } from "antd";
import { useEffect, useRef, useState } from "react";
import { parseAppearancePreference } from "@cocalc/util/appearance";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { useAppearance } from "./use-appearance";

export function AppearanceControl() {
  const { preference, resolved, setPreference, saveError } = useAppearance();
  const attempted = useRef(false);
  const [showError, setShowError] = useState(false);
  useEffect(() => {
    if (attempted.current) setShowError(!!saveError);
  }, [saveError]);
  const ThemeIcon =
    preference === "system"
      ? DesktopOutlined
      : preference === "dark"
        ? MoonOutlined
        : SunOutlined;
  return (
    <Popover
      content={
        <span role="alert" style={{ display: "block", maxWidth: 300 }}>
          {saveError}
        </span>
      }
      open={showError && !!saveError}
      onOpenChange={setShowError}
      trigger="click"
      placement="bottomRight"
    >
      <label
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          color: UI_COLORS.text,
        }}
        title={`Appearance: ${preference} (${resolved})`}
      >
        <ThemeIcon aria-hidden />
        <select
          aria-label="Appearance"
          onKeyDown={(event) => {
            if (event.key === "Escape" && showError) {
              setShowError(false);
              event.stopPropagation();
            }
          }}
          value={preference}
          onChange={(event) => {
            const next = parseAppearancePreference(event.target.value);
            if (next) {
              attempted.current = true;
              void setPreference(next);
            }
          }}
          style={{
            background: UI_COLORS.surface,
            color: UI_COLORS.text,
            border: `1px solid ${saveError ? UI_COLORS.danger : UI_COLORS.controlBorder}`,
            borderRadius: 4,
            font: "inherit",
            height: 32,
            width: 108,
            maxWidth: "100%",
            padding: "0 6px",
          }}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
    </Popover>
  );
}
