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

export function AppearanceControl({ compact = false }: { compact?: boolean }) {
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
          position: "relative",
        }}
        title={`Appearance: ${preference} (${resolved})`}
      >
        <ThemeIcon
          aria-hidden
          style={
            compact
              ? {
                  position: "absolute",
                  insetInlineStart: 8,
                  pointerEvents: "none",
                }
              : undefined
          }
        />
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
            background: compact ? "transparent" : UI_COLORS.surface,
            color: compact ? "transparent" : UI_COLORS.text,
            border:
              compact && !saveError
                ? "none"
                : `1px solid ${saveError ? UI_COLORS.danger : UI_COLORS.controlBorder}`,
            borderRadius: 4,
            font: "inherit",
            height: compact ? 24 : 32,
            width: compact ? 32 : 108,
            appearance: compact ? "none" : undefined,
            cursor: "pointer",
            maxWidth: "100%",
            padding: "0 6px",
          }}
        >
          <option
            style={{ color: UI_COLORS.text, background: UI_COLORS.surface }}
            value="system"
          >
            System
          </option>
          <option
            style={{ color: UI_COLORS.text, background: UI_COLORS.surface }}
            value="light"
          >
            Light
          </option>
          <option
            style={{ color: UI_COLORS.text, background: UI_COLORS.surface }}
            value="dark"
          >
            Dark
          </option>
        </select>
      </label>
    </Popover>
  );
}
