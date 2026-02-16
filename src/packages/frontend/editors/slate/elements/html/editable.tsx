/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { Editor, Transforms } from "slate";
import { register } from "../register";
import { useFocused, useSelected, useSlate } from "../hooks";
import { ensure_ends_in_two_newline, FOCUSED_COLOR } from "../../util";
import HTML from "@cocalc/frontend/components/html-ssr";
import { ReactEditor } from "../../slate-react";
import { CodeBlockBody } from "../code-block/code-like";

function isBR(s: string): boolean {
  const x = s.toLowerCase().replace(/\s/g, "");
  return x == "<br>" || x == "<br/>";
}

const Element = ({ attributes, children, element }) => {
  const focused = useFocused();
  const selected = useSelected();
  const border =
    focused && selected
      ? `1px solid ${FOCUSED_COLOR}`
      : `1px solid transparent`;
  const html = ((element.html as string) ?? "").trim();

  // this feels ugly in practice, and we have the source so not doing it.
  const is_comment = false;
  // const is_comment = html.startsWith("<!--") && html.endsWith("-->");

  const editor = useSlate();
  const selection = editor.selection;
  const [forceEdit, setForceEdit] = useState(false);

  const isEditing = forceEdit || (focused && selected);

  useEffect(() => {
    if (!focused) {
      setForceEdit(false);
      return;
    }
    if (selection && !isEditing && forceEdit) {
      setForceEdit(false);
    }
  }, [forceEdit, focused, isEditing, selection]);
  useEffect(() => {
    if (focused && selected) {
      setForceEdit(true);
    }
  }, [focused, selected]);

  useEffect(() => {
    if (!element.isVoid) return;
    try {
      const path = ReactEditor.findPath(editor as any, element as any);
      Transforms.setNodes(editor, { isVoid: false } as any, { at: path });
    } catch {
      // ignore
    }
  }, [editor, element]);
  // html elements are always non-void to allow multiline editing like code blocks

  function renderRaw() {
    if (!isEditing) return;
    if (element.type === "html_block") {
      return <CodeBlockBody>{children}</CodeBlockBody>;
    }
    return (
      <span style={{ display: "inline-block", marginLeft: "6px" }}>
        {children}
      </span>
    );
  }

  if (element.type == "html_inline") {
    return (
      <span {...attributes}>
        {!isEditing && (
          <code
            style={{ color: is_comment ? "#a50" : "#aaa", border }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              try {
                const path = ReactEditor.findPath(editor as any, element as any);
                const start = Editor.start(editor, path);
                Transforms.select(editor, start);
                ReactEditor.focus(editor as any);
                setForceEdit(true);
              } catch {
                // ignore
              }
            }}
          >
            {html}
          </code>
        )}
        {isBR(html) && <br />}
        {renderRaw()}
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
      </span>
    );
  } else {
    if (is_comment) {
      return (
        <div {...attributes}>
          <div style={{ color: "#a50" }}>{html}</div>
          {children}
        </div>
      );
    }
    return (
      <div {...attributes}>
        {!isEditing && (
          <div
            style={{ border, whiteSpace: "normal" }}
            contentEditable={false}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              try {
                const path = ReactEditor.findPath(editor as any, element as any);
                const start = Editor.start(editor, path);
                Transforms.select(editor, start);
                ReactEditor.focus(editor as any);
                setForceEdit(true);
              } catch {
                // ignore
              }
            }}
          >
            <HTML value={html} />
          </div>
        )}
        {renderRaw()}
        {!isEditing && (
          <div
            style={{
              position: "absolute",
              left: "-10000px",
              height: 0,
              overflow: "hidden",
            }}
          >
            {children}
          </div>
        )}
      </div>
    );
  }
};

register({
  slateType: "html_inline",
  Element,
  fromSlate: ({ node }) => node.html as string,
});

register({
  slateType: "html_block",
  Element,
  fromSlate: ({ node }) => ensure_ends_in_two_newline(node.html as string),
});
