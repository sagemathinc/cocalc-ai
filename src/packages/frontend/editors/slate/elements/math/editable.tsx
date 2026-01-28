/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React, { useEffect, useState } from "react";
import { Editor, Node, Path, Transforms } from "slate";
import { register, RenderElementProps } from "../register";
import { useFocused, useSelected, useSlate } from "../hooks";
import { ReactEditor, useSlateSelection } from "../../slate-react";
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
  const selection = useSlateSelection();
  const [forceEdit, setForceEdit] = useState(false);
  let editing = false;
  if (selection) {
    try {
      const path = ReactEditor.findPath(editor as any, element as any);
      const { anchor, focus } = selection;
      const contains = (p: Path) =>
        Path.isAncestor(path, p) || Path.equals(path, p);
      editing = contains(anchor.path) && contains(focus.path);
    } catch {
      // DEBUG: log selection issues while we stabilize inline math editing.
      console.warn("[slate-math] selection lookup failed", {
        selection,
        element,
      });
      editing = false;
    }
  }
  const isEditing = forceEdit || (focused && (selected || editing));
  useEffect(() => {
    if (forceEdit && (!focused || !editing)) {
      setForceEdit(false);
    }
  }, [forceEdit, focused, editing]);
  useEffect(() => {
    if (focused && selected) {
      setForceEdit(true);
    }
  }, [focused, selected]);
  const value = element.value ?? Node.string(element);

  const Wrapper: any = element.type === "math_block" ? "div" : "span";
  const delim = element.type === "math_block" ? "$$" : "$";
  const wrapperStyle =
    element.type === "math_block"
      ? { display: "block", position: "relative" as const }
      : { display: "inline-block", position: "relative" as const };
  const previewStyle: React.CSSProperties = {
    position: "absolute",
    right: element.type === "math_block" ? "4px" : "-4px",
    top: element.type === "math_block" ? "2px" : "-0.6em",
    background: "rgba(255,255,255,0.9)",
    padding: "0 4px",
    borderRadius: "4px",
    pointerEvents: "none",
    zIndex: 2,
    maxWidth: element.type === "math_block" ? "95%" : "none",
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
      {isEditing && (
        <span contentEditable={false} style={previewStyle}>
          <StaticElement
            element={{ ...element, value } as any}
            attributes={{} as any}
            children={null as any}
          />
        </span>
      )}
      <span
        style={
          isEditing
            ? undefined
            : {
                position: "absolute",
                left: "-10000px",
                height: 0,
                overflow: "hidden",
              }
        }
      >
        {isEditing && (
          <span
            contentEditable={false}
            style={{ opacity: 0.6, userSelect: "none", marginRight: "4px" }}
          >
            {delim}
          </span>
        )}
        {children}
        {isEditing && (
          <span
            contentEditable={false}
            style={{ opacity: 0.6, userSelect: "none", marginLeft: "4px" }}
          >
            {delim}
          </span>
        )}
      </span>
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
