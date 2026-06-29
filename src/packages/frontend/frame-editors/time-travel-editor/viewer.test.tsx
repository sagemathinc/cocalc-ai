/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import { Viewer } from "./viewer";

const mockToIpynb = jest.fn((doc: any) => doc.toIpynb());

const mockEditableMarkdown = jest.fn((props: any) => (
  <div data-testid="editable-markdown" data-props={JSON.stringify(props)} />
));

const mockTextDocument = jest.fn((props: any) => (
  <div
    data-testid="text-document"
    data-syntax={props.syntaxHighlightExtension ?? ""}
    data-value={typeof props.value === "function" ? props.value() : props.value}
  />
));

jest.mock("@cocalc/frontend/editors/slate/editable-markdown", () => ({
  EditableMarkdown: (props: any) => mockEditableMarkdown(props),
}));

jest.mock("@cocalc/frontend/chat/viewer", () => (props: any) => (
  <div
    data-testid="chat-viewer"
    data-readonly={`${props.readOnly === true}`}
    data-show-thread-list={`${props.showThreadList === true}`}
    data-virtualized={`${props.virtualized !== false}`}
  />
));

jest.mock("@cocalc/frontend/editors/task-editor/history-viewer", () => ({
  TasksHistoryViewer: () => <div data-testid="tasks-viewer" />,
}));

jest.mock("@cocalc/frontend/frame-editors/frame-tree/hooks", () => ({
  getScale: () => 1,
}));

jest.mock(
  "@cocalc/frontend/frame-editors/whiteboard-editor/time-travel",
  () => ({
    __esModule: true,
    default: () => <div data-testid="whiteboard-viewer" />,
  }),
);

jest.mock("@cocalc/frontend/jupyter/history-viewer", () => ({
  HistoryViewer: () => <div data-testid="jupyter-viewer" />,
  to_ipynb: (doc: any) => mockToIpynb(doc),
}));

jest.mock("./document", () => ({
  TextDocument: (props: any) => mockTextDocument(props),
}));

jest.mock("./view-document", () => ({
  isObjectDoc: () => false,
}));

describe("TimeTravel Viewer", () => {
  const baseProps = {
    id: "frame-1",
    path: "/home/user/history.md",
    project_id: "project-1",
    font_size: 14,
    editor_settings: {},
    actions: {},
  };

  it("renders markdown history through read-only EditableMarkdown for rich copy", () => {
    render(
      <Viewer
        {...baseProps}
        ext="md"
        doc={() =>
          ({
            to_str: () => "**bold** [link](https://example.com)\n\n- item",
          }) as any
        }
      />,
    );

    const content = screen.getByTestId("timetravel-markdown-content");
    expect(content).toHaveStyle({
      minHeight: "100%",
    });
    expect(screen.getByTestId("editable-markdown")).not.toBeNull();
    expect(mockEditableMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "**bold** [link](https://example.com)\n\n- item",
        read_only: true,
        hidePath: true,
        disableWindowing: true,
        noVfill: true,
        showEditBar: false,
        height: "auto",
        autoMinHeight: 0,
      }),
    );
  });

  it("renders ipynb source as notebook JSON instead of internal object-doc text", () => {
    const doc = {
      to_str: () => "internal-jsonl",
      toIpynb: () => ({
        cells: [
          {
            cell_type: "code",
            source: ["2+3"],
            metadata: {},
            outputs: [],
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    };

    render(
      <Viewer
        {...baseProps}
        ext="ipynb"
        path="/home/user/history.ipynb"
        textMode
        doc={() => doc as any}
      />,
    );

    const textDocument = screen.getByTestId("text-document");
    expect(textDocument).toHaveAttribute("data-syntax", "js");
    expect(textDocument.getAttribute("data-value")).toContain('"cells"');
    expect(textDocument.getAttribute("data-value")).toContain("2+3");
    expect(textDocument.getAttribute("data-value")).not.toContain(
      "internal-jsonl",
    );
    expect(mockToIpynb).toHaveBeenCalledWith(doc);
  });

  it("renders chat history with the compact thread selector", () => {
    render(
      <Viewer
        {...baseProps}
        ext="chat"
        path="/home/user/history.chat"
        doc={() => ({ get: () => [] }) as any}
      />,
    );

    const viewer = screen.getByTestId("chat-viewer");
    expect(viewer).toHaveAttribute("data-readonly", "true");
    expect(viewer).toHaveAttribute("data-virtualized", "false");
    expect(viewer).toHaveAttribute("data-show-thread-list", "true");
  });
});
