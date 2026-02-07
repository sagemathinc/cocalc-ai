/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*

YAML metadata node, e.g., at the VERY top like this:

---
title: HW02
subtitle: Basic Rmd and Statistics
output:
  html_document:
    theme: spacelab
    highlight: tango
    toc: true
---


*/

import { Node, Transforms } from "slate";
import { register } from "../register";
import { useFocused, useSelected, useSlate } from "../hooks";
import { A } from "@cocalc/frontend/components";
import { ReactEditor } from "../../slate-react";
import { CodeBlockBody } from "../code-block/code-like";
import { useEffect } from "react";

register({
  slateType: "meta",

  Element: ({ attributes, children, element }) => {
    if (element.type != "meta") throw Error("bug");
    const editor = useSlate();
    const focused = useFocused();
    const selected = useSelected();
    const isEditing = focused && selected;
  // meta is always non-void to allow multiline editing like code blocks
    const value = element.value ?? Node.string(element);

    useEffect(() => {
      if (!element.isVoid) return;
      try {
        const path = ReactEditor.findPath(editor as any, element as any);
        Transforms.setNodes(editor, { isVoid: false } as any, { at: path });
      } catch {
        // ignore
      }
    }, [editor, element]);

    return (
      <div {...attributes}>
        <div contentEditable={false}>
          <span style={{ float: "right" }}>
            <A href="https://docs.ansible.com/ansible/latest/reference_appendices/YAMLSyntax.html">
              YAML
            </A>{" "}
            Header
          </span>
          <code>---</code>
        </div>
        {!isEditing && (
          <pre
            contentEditable={false}
            style={{ margin: 0, whiteSpace: "pre-wrap" }}
          >
            {value}
          </pre>
        )}
        {isEditing && <CodeBlockBody>{children}</CodeBlockBody>}
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
        <div contentEditable={false}>
          <code>---</code>
        </div>
      </div>
    );
  },

  fromSlate: ({ node }) => `---\n${node.value}\n---\n`,
});
