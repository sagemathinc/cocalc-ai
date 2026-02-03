/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { Modal } from "antd";

import { A, Paragraph, Text, Title } from "@cocalc/frontend/components";
import { IS_MACOS } from "@cocalc/frontend/feature";

interface Props {
  open: boolean;
  onClose: () => void;
}

const MOD = IS_MACOS ? "⌘" : "Ctrl";
const ALT = IS_MACOS ? "⌥" : "Alt";

const KB: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text code style={{ padding: "0 6px", marginRight: 4 }}>
    {children}
  </Text>
);

export const SlateHelpModal: React.FC<Props> = ({ open, onClose }) => {
  return (
    <Modal
      title="Markdown Editor Help"
      open={open}
      onCancel={onClose}
      onOk={onClose}
      okText="Close"
      cancelButtonProps={{ style: { display: "none" } }}
      width={700}
      destroyOnClose
    >
      <Title level={5}>Keyboard shortcuts</Title>
      <ul style={{ paddingLeft: 22 }}>
        <li>
          <KB>{MOD}+B</KB> bold, <KB>{MOD}+I</KB> italic,{" "}
          <KB>{MOD}+U</KB> underline
        </li>
        <li>
          <KB>{MOD}+Shift+X</KB> strikethrough, <KB>{MOD}+Shift+C</KB> code
        </li>
        <li>
          <KB>{MOD}+F</KB> find, <KB>{MOD}+G</KB> next match,{" "}
          <KB>Shift+{MOD}+G</KB> previous match
        </li>
        <li>
          <KB>{ALT}+Enter</KB> switch between Markdown source and rich text
        </li>
        <li>
          <KB>Tab</KB> / <KB>Shift+Tab</KB> indent / outdent list items
        </li>
        <li>
          <KB>
            {IS_MACOS ? "Ctrl+⌘" : MOD + "+Shift"}+↑
          </KB>{" "}
          /{" "}
          <KB>
            {IS_MACOS ? "Ctrl+⌘" : MOD + "+Shift"}+↓
          </KB>{" "}
          move list item up/down
        </li>
        <li>
          <KB>{IS_MACOS ? "Ctrl" : MOD}+D</KB> forward delete
        </li>
        <li>
          <KB>Shift+Enter</KB> soft line break
        </li>
      </ul>

      <Title level={5}>Supported features</Title>
      <ul style={{ paddingLeft: 22 }}>
        <li>Headings, paragraphs, lists, checkboxes via [ ]</li>
        <li>Tables</li>
        <li>Markdown references</li>
        <li>Links and images</li>
        <li>Pasting and resizing inline images</li>
        <li>Drag-and-drop upload of attachments</li>
        <li>#hashtags</li>
        <li>Emojis (e.g., :smile:)</li>
        <li>Inline and display math</li>
        <li>Fenced code blocks and inline code</li>
        <li>Mermaid diagrams via <Text code>```mermaid</Text></li>
        <li>Jupyter execution for code blocks</li>
        <li>HTML blocks (when present in Markdown)</li>
        <li>Metadata YAML headings</li>
        <li>
          Autoformat via <Text code>markdown[space]</Text> (use Shift+Space to
          avoid autoformat)
        </li>
      </ul>

      <Title level={5}>Block editor notes</Title>
      <ul style={{ paddingLeft: 22 }}>
        <li>
          Large documents are chunked into blocks for performance (page
          boundaries indicate chunks).
        </li>
        <li>
          Blank lines are treated as paragraphs in inline editors, but not in
          the block editor.
        </li>
        <li>
          Selection across blocks is block-based (use block selection for moving
          or deleting blocks).
        </li>
        <li>
          Some actions (like full-document find/replace) are more reliable in
          the source view.
        </li>
      </ul>

      <Paragraph>
        Full docs:{" "}
        <A href="https://doc.cocalc.com/markdown.html">
          https://doc.cocalc.com/markdown.html
        </A>
      </Paragraph>
    </Modal>
  );
};
