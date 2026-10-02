/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The search box at the top of the workspace sidebar. Typing narrows the
// list below it right away; Enter opens the full search results.

import { useEffect, useRef } from "react";
import { Input, type InputRef } from "antd";
import { Icon } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

// Ctrl/Cmd+Shift+P (and "Search all" in a chat) focus the box; the request
// may come before the sidebar is showing it.
let focusRequested = false;
const FOCUS_EVENT = "cocalc:focus-sidebar-search";
export function focusSidebarSearch(): void {
  focusRequested = true;
  window.dispatchEvent(new Event(FOCUS_EVENT));
}

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

export function SidebarSearchBox({
  label,
  value,
  onChange,
  onSubmit,
  onEscape,
  shortcutHint = true,
  inputRef,
}: {
  label: string; // "Search agents"
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onEscape?: () => void;
  // Show the Ctrl/Cmd+Shift+P hint (the shortcut focuses the sidebar's box).
  shortcutHint?: boolean;
  // For pages that focus their search box.
  inputRef?: React.RefObject<InputRef | null>;
}) {
  const ref = useRef<InputRef>(null);
  useEffect(() => {
    if (!shortcutHint) return;
    const focus = () => {
      if (!focusRequested) return;
      focusRequested = false;
      ref.current?.focus();
    };
    focus();
    window.addEventListener(FOCUS_EVENT, focus);
    return () => window.removeEventListener(FOCUS_EVENT, focus);
  }, []);
  return (
    <Input
      ref={(input) => {
        ref.current = input;
        if (inputRef) inputRef.current = input;
      }}
      type="search"
      allowClear
      aria-label={label}
      aria-description="Type to filter the list below; press Enter to search everything."
      placeholder={`${label}…`}
      prefix={<Icon name="search" style={{ color: UI_COLORS.secondary }} />}
      suffix={
        value || !shortcutHint ? undefined : (
          <span
            aria-hidden
            style={{ color: UI_COLORS.secondary, fontSize: 12 }}
            title="Ctrl/Cmd+Shift+P"
          >
            {isMac ? "⇧⌘P" : "Ctrl+⇧P"}
          </span>
        )
      }
      maxLength={256}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPressEnter={() => {
        if (value.trim()) onSubmit(value.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onChange("");
          onEscape?.();
        }
      }}
    />
  );
}
