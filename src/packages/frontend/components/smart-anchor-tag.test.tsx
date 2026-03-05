/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SmartAnchorTag from "./smart-anchor-tag";

const openFile = jest.fn();
const openDirectory = jest.fn();
const loadTarget = jest.fn();
const openProject = jest.fn();
const setActiveTab = jest.fn();
const isDir = jest.fn(async () => false);
const isDirViaCache = jest.fn(() => false);

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
        open_directory: openDirectory,
        isDir,
        isDirViaCache,
        load_target: loadTarget,
      }),
      getActions: (name?: string) => {
        if (name === "projects") {
          return { open_project: openProject };
        }
        if (name === "page") {
          return { set_active_tab: setActiveTab };
        }
        return {};
      },
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
    openDirectory.mockReset();
    loadTarget.mockReset();
    openProject.mockReset();
    setActiveTab.mockReset();
    isDir.mockReset();
    isDirViaCache.mockReset();
    isDir.mockResolvedValue(false);
    isDirViaCache.mockReturnValue(false);
    openMock.mockReset();
  });

  it("opens internal cocalc-file links via project open_file", async () => {
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
    await waitFor(() => {
      expect(openFile).toHaveBeenCalledWith({
        path: "/tmp/x/workspaces.py",
        line: 9,
        foreground: true,
        explicit: true,
      });
    });
  });

  it("opens absolute file links with :line suffix as file+line", async () => {
    render(
      <SmartAnchorTag
        project_id="00000000-1000-4000-8000-000000000000"
        path="room.chat"
        href="/tmp/x/workspaces.py:485"
      >
        workspaces.py:485
      </SmartAnchorTag>,
    );

    fireEvent.click(screen.getByRole("link", { name: "workspaces.py:485" }));
    await waitFor(() => {
      expect(openFile).toHaveBeenCalledWith({
        path: "/tmp/x/workspaces.py",
        line: 485,
        foreground: true,
        explicit: true,
      });
    });
  });

  it("opens absolute file links with trailing punctuation as file+line", async () => {
    render(
      <SmartAnchorTag
        project_id="00000000-1000-4000-8000-000000000000"
        path="room.chat"
        href="/Users/williamstein/build/cocalc-lite/src/packages/plus/reflect/manager.ts:485)."
      >
        manager.ts:485).
      </SmartAnchorTag>,
    );

    fireEvent.click(screen.getByRole("link", { name: "manager.ts:485)." }));
    await waitFor(() => {
      expect(openFile).toHaveBeenCalledWith({
        path: "/Users/williamstein/build/cocalc-lite/src/packages/plus/reflect/manager.ts",
        line: 485,
        foreground: true,
        explicit: true,
      });
    });
  });

  it("opens absolute file links with encoded :line suffix as file+line", async () => {
    render(
      <SmartAnchorTag
        project_id="00000000-1000-4000-8000-000000000000"
        path="room.chat"
        href="/tmp/x/workspaces.py%3A485"
      >
        workspaces.py%3A485
      </SmartAnchorTag>,
    );

    fireEvent.click(screen.getByRole("link", { name: "workspaces.py%3A485" }));
    await waitFor(() => {
      expect(openFile).toHaveBeenCalledWith({
        path: "/tmp/x/workspaces.py",
        line: 485,
        foreground: true,
        explicit: true,
      });
    });
  });

  it("opens absolute file links with #L anchors as file+line", async () => {
    render(
      <SmartAnchorTag
        project_id="00000000-1000-4000-8000-000000000000"
        path="room.chat"
        href="/tmp/x/workspaces.py#L42"
      >
        workspaces.py#L42
      </SmartAnchorTag>,
    );

    fireEvent.click(screen.getByRole("link", { name: "workspaces.py#L42" }));
    await waitFor(() => {
      expect(openFile).toHaveBeenCalledWith({
        path: "/tmp/x/workspaces.py",
        line: 42,
        foreground: true,
        explicit: true,
      });
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

  it("opens relative links with encoded :line suffix as file+line", async () => {
    render(
      <SmartAnchorTag
        project_id="00000000-1000-4000-8000-000000000000"
        path="/home/wstein/project/chat.room"
        href="src/workspaces.py%3A77"
      >
        src/workspaces.py%3A77
      </SmartAnchorTag>,
    );

    fireEvent.click(screen.getByRole("link", { name: "src/workspaces.py%3A77" }));
    await waitFor(() => {
      expect(loadTarget).toHaveBeenCalledWith(
        "files/home/wstein/project/src/workspaces.py",
        true,
        false,
        true,
        expect.objectContaining({ line: "77" }),
      );
    });
  });
});
