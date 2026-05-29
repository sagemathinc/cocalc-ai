/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button } from "antd";
import type { CSS } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";

interface Props {
  onFocus: () => void;
  onPaste: (text?: string) => void;
  onSendData: (data: string) => void;
}

const TOOLBAR_STYLE: CSS = {
  alignItems: "center",
  background: "rgba(248, 248, 248, 0.96)",
  borderBottom: "1px solid #d9d9d9",
  display: "flex",
  gap: "4px",
  minHeight: "34px",
  overflowX: "auto",
  padding: "3px 6px",
  WebkitOverflowScrolling: "touch",
};

const BUTTON_STYLE: CSS = {
  flex: "0 0 auto",
  minWidth: "34px",
  paddingLeft: "6px",
  paddingRight: "6px",
};

const KEYS = [
  { label: "Esc", title: "Escape", data: "\x1b" },
  { label: "Tab", title: "Tab", data: "\x09" },
  { label: "^C", title: "Control+C", data: "\x03" },
  { label: "`", title: "Backtick", data: "`" },
  { label: "←", title: "Left arrow", data: "\x1b[D" },
  { label: "↑", title: "Up arrow", data: "\x1b[A" },
  { label: "↓", title: "Down arrow", data: "\x1b[B" },
  { label: "→", title: "Right arrow", data: "\x1b[C" },
];

export function MobileTerminalToolbar({ onFocus, onPaste, onSendData }: Props) {
  function send(data: string): void {
    onFocus();
    onSendData(data);
  }

  async function paste(): Promise<void> {
    let text: string | undefined;
    try {
      text = await navigator.clipboard?.readText();
    } catch (_) {
      // Fall back to CoCalc's internal terminal copy/paste buffer.
    }
    onFocus();
    onPaste(text);
  }

  return (
    <div
      aria-label="Mobile terminal controls"
      style={TOOLBAR_STYLE}
      onTouchStart={(event) => {
        event.stopPropagation();
      }}
    >
      <Button
        aria-label="Paste"
        size="small"
        style={BUTTON_STYLE}
        title="Paste"
        onClick={() => void paste()}
      >
        <Icon name="paste" />
      </Button>
      {KEYS.map(({ data, label, title }) => (
        <Button
          key={title}
          size="small"
          style={BUTTON_STYLE}
          title={title}
          onClick={() => send(data)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
