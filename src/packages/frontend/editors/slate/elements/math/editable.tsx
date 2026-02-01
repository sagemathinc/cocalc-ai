/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React, { useEffect, useState } from "react";
import { Editor, Node, Range, Transforms } from "slate";
import { register, RenderElementProps } from "../register";
import { useFocused, useSelected, useSlate } from "../hooks";
import { ReactEditor } from "../../slate-react";
import { StaticElement } from "./index";

const Element: React.FC<RenderElementProps> = ({
  attributes,
  children,
  element,
}) => {
  if (element.type != "math_block" && element.type != "math_inline") {
    // type guard.
    throw Error("bug");
  }
  const editor = useSlate();
  const focused = useFocused();
  const selected = useSelected();
  const selection = editor.selection;
  const [forceEdit, setForceEdit] = useState(false);
  const isCollapsed = selection ? Range.isCollapsed(selection) : false;
  const isEditing = isCollapsed && (forceEdit || (focused && selected));
  useEffect(() => {
    if (!isCollapsed && forceEdit) {
      setForceEdit(false);
      return;
    }
    if (forceEdit && (!focused || !isEditing)) {
      setForceEdit(false);
    }
  }, [forceEdit, focused, isEditing, isCollapsed]);
  useEffect(() => {
    if (focused && selected && isCollapsed) {
      setForceEdit(true);
    }
  }, [focused, selected, isCollapsed]);
  useEffect(() => {
    try {
      const path = ReactEditor.findPath(editor as any, element as any);
      const desired = !isEditing;
      if ((element as any).isVoid !== desired) {
        Transforms.setNodes(editor, { isVoid: desired } as any, { at: path });
      }
    } catch {
      // ignore
    }
  }, [editor, element, isEditing]);
  const value = element.value ?? Node.string(element);

  const Wrapper: any = element.type === "math_block" ? "div" : "span";
  const delim = element.type === "math_block" ? "$$" : "$";
  const wrapperStyle =
    element.type === "math_block"
      ? { display: "block", position: "relative" as const }
      : { display: "inline-block", position: "relative" as const };
  const previewStyle: React.CSSProperties =
    element.type === "math_block"
      ? {
          display: "block",
          marginTop: "4px",
          background: "rgba(255,255,255,0.95)",
          padding: "0 4px",
          borderRadius: "4px",
          pointerEvents: "none",
          zIndex: 2,
          maxWidth: "100%",
        }
      : {
          display: "inline-block",
          marginLeft: "6px",
          background: "rgba(255,255,255,0.95)",
          padding: "0 4px",
          borderRadius: "4px",
          pointerEvents: "none",
          zIndex: 2,
          whiteSpace: "nowrap",
        };
  return (
    <Wrapper {...attributes} style={wrapperStyle}>
      {!isEditing && (
        <span
          contentEditable={false}
          onMouseDown={(e) => {
            // Move selection into the math node so editing switches to raw LaTeX.
            e.preventDefault();
            e.stopPropagation();
            try {
              const path = ReactEditor.findPath(editor as any, element as any);
              const start = Editor.start(editor, path);
              Transforms.select(editor, start);
              ReactEditor.focus(editor as any);
              setForceEdit(true);
            } catch {
              console.warn("[slate-math] click-to-edit failed", {
                selection: editor.selection,
                element,
              });
              // ignore
            }
          }}
        >
          <StaticElement
            element={{ ...element, value } as any}
            attributes={{} as any}
            children={null as any}
          />
        </span>
      )}
      {!isEditing && (
        <span
          style={{
            position: "absolute",
            left: "-10000px",
            height: 0,
            overflow: "hidden",
          }}
        >
          {children}
        </span>
      )}
      {isEditing && (
        <span
          style={
            element.type === "math_block"
              ? { display: "block", marginTop: "4px" }
              : { display: "inline-block", marginLeft: "6px" }
          }
        >
          <span
            contentEditable={false}
            style={{ opacity: 0.6, userSelect: "none", marginRight: "4px" }}
          >
            {delim}
          </span>
          {children}
          <span
            contentEditable={false}
            style={{ opacity: 0.6, userSelect: "none", marginLeft: "4px" }}
          >
            {delim}
          </span>
        </span>
      )}
      {isEditing && (
        <span contentEditable={false} style={previewStyle}>
          <StaticElement
            element={{ ...element, value } as any}
            attributes={{} as any}
            children={null as any}
          />
        </span>
      )}
    </Wrapper>
  );
};

register({
  slateType: "math_inline",
  Element,
  fromSlate: ({ node }) => {
    const value = (node.value ?? Node.string(node)).trim();
    const delim = value.startsWith("\\begin{") ? "" : node.display ? "$$" : "$";
    return `${delim}${value}${delim}`;
  },
});

register({
  slateType: "math_block",
  Element,
  fromSlate: ({ node }) => {
    const value = (node.value ?? Node.string(node)).trim();
    let start, end;
    if (value.startsWith("\\begin{")) {
      start = "";
      end = "\n\n";
    } else {
      start = "\n$$\n";
      end = "\n$$\n\n";
    }
    return `${start}${value}${end}`;
  },
});
