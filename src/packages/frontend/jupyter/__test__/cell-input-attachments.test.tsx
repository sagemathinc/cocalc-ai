/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Pasted-image attachments and data: images in Markdown cells survive
// sanitizing, through the real CellInput.  (From @lite4-opus-review's repro
// for PR #20.)

import { Map, fromJS } from "immutable";
import { fireEvent, render, screen } from "@testing-library/react";

import { CellInput } from "../cell-input";
import { NotebookFileContext } from "../notebook-file-context";

let latestMarkdownInputProps: any = null;

jest.mock("@cocalc/frontend/components/hidden-visible", () => ({
  HiddenXS: ({ children }) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => ({
  __esModule: true,
  default: (props: any) => {
    latestMarkdownInputProps = props;
    return <div data-testid="markdown-input" />;
  },
}));

jest.mock(
  "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/hook",
  () => ({
    __esModule: true,
    default: () => ({
      current: {
        adjacentCell: jest.fn(),
        register_input_editor: jest.fn(),
        set_cur_id: jest.fn(),
        set_md_cell_not_editing: jest.fn(),
        set_mode: jest.fn(),
        unselect_all_cells: jest.fn(),
        unregister_input_editor: jest.fn(),
      },
    }),
  }),
);

jest.mock("../cell-buttonbar", () => ({
  CellButtonBar: () => null,
}));

jest.mock("../cell-hidden-part", () => ({
  CellHiddenPart: ({ onReveal, revealLabel }) =>
    onReveal == null ? (
      <span data-testid="hidden-cell-input" />
    ) : (
      <button aria-label={revealLabel} onClick={onReveal} type="button" />
    ),
}));

jest.mock("../cell-toolbar", () => ({
  CellToolbar: () => null,
}));

jest.mock("../codemirror-component", () => ({
  CodeMirror: () => null,
}));

jest.mock("../prompt/input", () => ({
  InputPrompt: () => null,
}));

jest.mock("../run-cell-overlay", () => ({
  getDisplayedCellExecCount: () => null,
}));

it.each([
  ["markdown", "![pasted](attachment:image.png)"],
  ["html", '<img src="attachment:image.png" alt="pasted">'],
  [
    "data: image",
    '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==">',
  ],
])("attachment image through the real CellInput (%s)", (_n, input) => {
  const { container } = render(
    <NotebookFileContext trust>
      <CellInput
        cell={
          fromJS({
            id: "cell-1",
            cell_type: "markdown",
            input,
            metadata: {},
            attachments: {
              "image.png": {
                type: "base64",
                value:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
              },
            },
          }) as Map<string, any>
        }
        cm_options={fromJS({ markdown: {}, options: {} }) as Map<string, any>}
        id="cell-1"
        index={0}
        is_markdown_edit={false}
        is_focused={false}
        is_current={false}
        font_size={14}
        is_readonly={false}
        input_is_readonly={false}
        trust
      />
    </NotebookFileContext>,
  );
  const srcs = Array.from(container.querySelectorAll("img")).map((i) =>
    (i.getAttribute("src") ?? "(no src)").slice(0, 30),
  );
  expect(srcs.length).toBe(1);
  expect(srcs[0]).toMatch(/^data:image\/png;base64,/);
});
