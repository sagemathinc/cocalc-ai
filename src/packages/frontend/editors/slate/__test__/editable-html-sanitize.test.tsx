/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The WYSIWYG ("editor") mode a Markdown cell enters on double-click renders
// html_block previews with html-ssr, under the notebook's context: sanitized
// even in a trusted notebook.  (From @lite4-opus-review's repro for PR #20.)

import { render } from "@testing-library/react";
import { NotebookFileContext } from "@cocalc/frontend/jupyter/notebook-file-context";
import { EditableMarkdown } from "../editable-markdown";

jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

it("html block preview while editing a trusted notebook's Markdown cell", () => {
  const value =
    'Intro paragraph.\n\n<div class="ant-modal" style="position: fixed; inset: 0; z-index: 9999; background: url(https://evil.example/t.png)">overlay</div>\n\nAfter.\n';
  const { container } = render(
    <NotebookFileContext trust>
      <EditableMarkdown
        value={value}
        is_current
        enableUpload={false}
        minimal
        hidePath
        disableWindowing
        noVfill
        showEditBar={false}
        height="auto"
      />
    </NotebookFileContext>,
  );
  const el = Array.from(container.querySelectorAll("div")).find(
    (d) => d.textContent === "overlay" && d.children.length === 0,
  );
  expect(el).toBeDefined();
  expect(el!.outerHTML).not.toMatch(/position: fixed|url\(|ant-modal/);
});
