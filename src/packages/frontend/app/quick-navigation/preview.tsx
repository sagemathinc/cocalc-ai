/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties } from "react";
import { Button, Typography } from "antd";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { Editor, Layout } from "./model";

// A square miniature of the editor's split/tab layout. Only the arrangement
// is reproduced; every sibling gets the same share so labels stay readable.
// Buttons are not tab stops: the dialog cycles focus between its own
// controls, and frames are chosen with digits, Enter, or a click.
export function FramePreview({
  editor,
  selectedId,
  onChoose,
}: {
  editor: Editor;
  selectedId?: string;
  onChoose: (id: string) => void;
}) {
  const numbers = new Map(
    editor.frames
      .filter((frame) => frame.type !== "chat")
      .slice(0, 9)
      .map((frame, index) => [frame.id, index + 1]),
  );
  function render(node: Layout, key: string) {
    if (node.frame) {
      const { frame } = node;
      const number = frame.type === "chat" ? 0 : numbers.get(frame.id);
      return (
        <Button
          key={key}
          tabIndex={-1}
          title={frame.label}
          aria-label={
            number != null ? `${number} · ${frame.label}` : frame.label
          }
          onClick={() => onChoose(frame.id)}
          aria-pressed={frame.id === selectedId}
          style={{
            flex: 1,
            width: "100%",
            height: "auto",
            minHeight: 32,
            minWidth: 0,
            padding: "4px 6px",
            fontSize: 12,
            outline:
              frame.id === selectedId
                ? `2px solid ${UI_COLORS.focus}`
                : undefined,
          }}
        >
          <span style={{ display: "block", width: "100%", minWidth: 0 }}>
            {number != null && (
              <strong style={{ display: "block", fontSize: "1.2em" }}>
                {number}
              </strong>
            )}
            <span
              style={{
                display: "block",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {frame.short ?? frame.label}
            </span>
          </span>
        </Button>
      );
    }
    const style: CSSProperties = {
      display: "flex",
      // Frame directions describe the divider, not CSS flex-direction.
      flexDirection: node.tabs || node.direction === "col" ? "row" : "column",
      flexWrap: node.tabs ? "wrap" : undefined,
      gap: 5,
      flex: 1,
      minWidth: 0,
      minHeight: 0,
    };
    return (
      <div key={key} style={style}>
        {node.tabs && (
          <Typography.Text type="secondary" style={{ flexBasis: "100%" }}>
            Tabs
          </Typography.Text>
        )}
        {node.children?.map((child, index) => (
          <div
            key={index}
            style={{
              display: "flex",
              flex: node.tabs ? "1 1 80px" : 1,
              minWidth: 0,
              minHeight: 0,
            }}
          >
            {render(child, `${key}-${index}`)}
          </div>
        ))}
      </div>
    );
  }
  if (!editor.layout) return null;
  return (
    <div
      data-testid="frame-preview"
      style={{ display: "flex", width: "100%", aspectRatio: "1 / 1" }}
    >
      {render(editor.layout, "layout")}
    </div>
  );
}

export function numberedFrame(editor: Editor | undefined, digit: string) {
  if (digit === "0")
    return editor?.frames.find((frame) => frame.type === "chat");
  return editor?.frames.filter((frame) => frame.type !== "chat")[
    Number(digit) - 1
  ];
}
