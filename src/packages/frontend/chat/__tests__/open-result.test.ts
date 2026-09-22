import { openProjectFileResult } from "../open-result";
import { readArtifact } from "@cocalc/chat";

jest.mock("@cocalc/chat", () => ({
  readArtifact: jest.fn(),
}));

describe("openProjectFileResult", () => {
  it("focuses an existing pane for the same chat, path, and revision", () => {
    const setActive = jest.fn();
    const split = jest.fn();
    const data: Record<string, Record<string, string>> = {
      "pane-1": {
        path: "/home/user/report.pdf",
        origin: "chat-1",
        revision: "abc",
      },
    };
    const frames = {
      get_frame_ids_in_order: () => ["chat-1", "pane-1"],
      _get_frame_type: (id: string) =>
        id === "pane-1" ? "workbench" : "chatroom",
      _get_frame_data: (id: string, key: string) => data[id]?.[key],
      set_active_id: setActive,
      set_frame_full: jest.fn(),
      split_frame: split,
      move_frame: jest.fn(),
    };
    openProjectFileResult(
      { frameId: "chat-1", frameTreeActions: frames } as any,
      {
        kind: "file",
        path: "/home/user/report.pdf",
        revision: "abc",
      },
    );
    expect(setActive).toHaveBeenCalledWith("pane-1");
    expect(split).not.toHaveBeenCalled();
  });

  it("opens a new Workbench tab for a different result", () => {
    const split = jest.fn(() => "pane-2");
    const move = jest.fn();
    const frames = {
      get_frame_ids_in_order: () => ["chat-1", "workbench-1"],
      _get_frame_type: (id: string) =>
        id === "workbench-1" ? "workbench" : "chatroom",
      _get_frame_data: () => undefined,
      set_active_id: jest.fn(),
      set_frame_full: jest.fn(),
      split_frame: split,
      move_frame: move,
    };
    openProjectFileResult(
      { frameId: "chat-1", frameTreeActions: frames } as any,
      { kind: "file", path: "/home/user/result.md", line: 8 },
    );
    expect(split).toHaveBeenCalledWith("col", "chat-1", "workbench", {
      "data-path": "/home/user/result.md",
      "data-line": 8,
      "data-revision": undefined,
      "data-thread": undefined,
      "data-origin": "chat-1",
      "data-tabLabel": "result.md",
    });
    expect(move).toHaveBeenCalledWith("pane-2", "workbench-1", "tab");
  });

  it("reuses an artifact Workbench pane for a link to the same file", () => {
    (readArtifact as jest.Mock).mockReturnValue({
      artifact: { file: { path: "/home/user/report.pdf" } },
    });
    const setActive = jest.fn();
    const split = jest.fn();
    const data: Record<string, Record<string, string>> = {
      "pane-1": {
        artifact: "report",
        thread: "thread-1",
        origin: "chat-1",
      },
    };
    const frames = {
      get_frame_ids_in_order: () => ["chat-1", "pane-1"],
      _get_frame_type: (id: string) =>
        id === "pane-1" ? "workbench" : "chatroom",
      _get_frame_data: (id: string, key: string) => data[id]?.[key],
      set_active_id: setActive,
      set_frame_full: jest.fn(),
      split_frame: split,
      move_frame: jest.fn(),
    };
    openProjectFileResult(
      {
        frameId: "chat-1",
        frameTreeActions: frames,
        syncdb: { get_one: jest.fn() },
      } as any,
      { kind: "file", path: "/home/user/report.pdf" },
    );
    expect(readArtifact).toHaveBeenCalledWith(expect.anything(), {
      artifact_id: "report",
      thread_id: "thread-1",
    });
    expect(setActive).toHaveBeenCalledWith("pane-1");
    expect(split).not.toHaveBeenCalled();
  });
});
