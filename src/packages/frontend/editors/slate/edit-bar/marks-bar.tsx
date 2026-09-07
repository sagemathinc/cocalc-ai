/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button } from "antd";
import React, { CSSProperties } from "react";

import { Icon, IconName, Tooltip } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { SlateEditor } from "../editable-markdown";
import { formatAction } from "../format";
import ColorButton from "./color-button";
import FontFamily from "./font-family";
import FontSize from "./font-size";
import Heading from "./heading";
import Insert from "./insert";
import CodeButton from "./code";
import LinkButton from "./link";
import { Marks } from "./marks";

export const BUTTON_STYLE = {
  color: UI_COLORS.text,
  height: "24px",
  borderLeft: `1px solid ${UI_COLORS.border}`,
  borderRight: `1px solid ${UI_COLORS.border}`,
  borderTop: "none",
  borderBottom: "none",
  padding: "0 10px",
} as CSSProperties;

interface MarkButtonProps {
  mark: IconName;
  active: boolean;
  editor: SlateEditor;
}

const MarkButton: React.FC<MarkButtonProps> = ({ mark, active, editor }) => {
  return (
    <Tooltip title={TITLES[mark]} mouseEnterDelay={1}>
      <Button
        aria-label={TITLES[mark]}
        aria-pressed={active}
        type="text"
        style={{
          ...BUTTON_STYLE,
          backgroundColor: active ? UI_COLORS.hover : undefined,
        }}
        onClick={() => formatAction(editor, mark, [])}
      >
        <Icon name={mark} />
      </Button>
    </Tooltip>
  );
};

interface MarksBarProps {
  marks: Marks;
  editor: SlateEditor;
}

const MARKS: IconName[] = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "code",
  /*"sup",
      "sub",*/
];

const TITLES = {
  bold: "Bold (shortcut: **foo**␣)",
  italic: "Italics (shortcut: *foo*␣)",
  underline: "Underline (shortcut: _foo_␣)",
  strikethrough: "Strikethrough (shortcut: ~foo~␣)",
  code: "Code (shortcut: `foo`␣)",
  sup: "Superscript",
  sub: "Subscript",
};

export const MarksBar: React.FC<MarksBarProps> = (props: MarksBarProps) => {
  const { marks, editor } = props;
  const v: React.JSX.Element[] = [];
  v.push(<Insert key="insert" editor={editor} />);
  for (const mark of MARKS) {
    v.push(
      <MarkButton
        key={mark}
        mark={mark}
        active={marks[mark] ?? false}
        editor={editor}
      />,
    );
  }
  v.push(<CodeButton key={"code2"} editor={editor} />);
  v.push(<LinkButton key={"link"} editor={editor} />);
  v.push(<FontSize key={"size"} editor={editor} size={getSizeMark(marks)} />);
  v.push(<Heading key="heading" editor={editor} />);
  v.push(
    <ColorButton key={"color"} editor={editor} color={getColorMark(marks)} />,
  );
  v.push(<FontFamily key={"font"} editor={editor} font={getFontMark(marks)} />);
  return (
    <div
      className="cocalc-slate-marks"
      style={{ paddingRight: "10px", flex: 1, whiteSpace: "nowrap" }}
    >
      {v}
    </div>
  );
};

function getColorMark(marks): string | undefined {
  for (const key in marks) {
    if (key.startsWith("color:") && marks[key]) {
      return key.slice("color:".length);
    }
  }
}

function getFontMark(marks): string | undefined {
  for (const key in marks) {
    if (key.startsWith("font-family:") && marks[key]) {
      return key.slice("font-family:".length);
    }
  }
}

function getSizeMark(marks): string | undefined {
  for (const key in marks) {
    if (key.startsWith("font-size:") && marks[key]) {
      return key.slice("font-size:".length);
    }
  }
}
