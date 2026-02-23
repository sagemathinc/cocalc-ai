/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import SmartAnchorTag from "./smart-anchor-tag";

const openFile = jest.fn();

jest.mock("@cocalc/frontend/components", () => ({
  A: ({ href, title, onClick, children }) => (
    <a href={href} title={title} onClick={onClick}>
      {children}
    </a>
  ),
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    redux: {
      ...(actual.redux ?? {}),
      getProjectActions: () => ({
        open_file: openFile,
      }),
      getActions: () => ({}),
    },
  };
});

describe("SmartAnchorTag", () => {
  let openMock: jest.SpyInstance;

  beforeAll(() => {
    openMock = jest.spyOn(window, "open").mockImplementation(() => null);
  });

  afterAll(() => {
    openMock.mockRestore();
  });

  beforeEach(() => {
    openFile.mockReset();
    openMock.mockReset();
  });

  it("opens internal cocalc-file links via project open_file", () => {
    render(
      <SmartAnchorTag
        project_id="00000000-1000-4000-8000-000000000000"
        path="room.chat"
        href="cocalc-file://open?path=%2Ftmp%2Fx%2Fworkspaces.py&line=9"
      >
        workspaces.py
      </SmartAnchorTag>,
    );

    fireEvent.click(screen.getByRole("link", { name: "workspaces.py" }));
    expect(openFile).toHaveBeenCalledWith({
      path: "/tmp/x/workspaces.py",
      line: 9,
      foreground: true,
      explicit: true,
    });
  });

  it("treats absolute slash links as host-root navigation", () => {
    render(
      <SmartAnchorTag
        project_id="00000000-1000-4000-8000-000000000000"
        path="room.chat"
        href="/blobs/file.png?uuid=123"
      >
        blob
      </SmartAnchorTag>,
    );

    fireEvent.click(screen.getByRole("link", { name: "blob" }), {
      ctrlKey: true,
    });
    expect(openMock).toHaveBeenCalledWith(
      "/blobs/file.png?uuid=123",
      "_blank",
      "noopener",
    );
    expect(openFile).not.toHaveBeenCalled();
  });
});
