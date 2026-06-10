/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import { Viewer } from "./viewer";

const mockEditableMarkdown = jest.fn((props: any) => (
  <div data-testid="editable-markdown" data-props={JSON.stringify(props)} />
));

jest.mock("@cocalc/frontend/editors/slate/editable-markdown", () => ({
  EditableMarkdown: (props: any) => mockEditableMarkdown(props),
}));

jest.mock("@cocalc/frontend/chat/viewer", () => () => (
  <div data-testid="chat-viewer" />
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
}));

jest.mock("./document", () => ({
  TextDocument: () => <div data-testid="text-document" />,
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
});
