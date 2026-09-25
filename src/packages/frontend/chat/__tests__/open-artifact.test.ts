import { openArtifact } from "../open-artifact";

test("opening latest never reuses a historical snapshot tab", () => {
  const frames: any = {
    get_frame_ids_in_order: () => ["history"],
    _get_frame_type: () => "workbench",
    _get_frame_data: (_id, key) =>
      ({ artifact: "doc", thread: "source", origin: "chat", version: "old" })[
        key
      ],
    split_frame: jest.fn(() => "latest"),
    move_frame: jest.fn(),
    set_active_id: jest.fn(),
    set_frame_full: jest.fn(),
  };
  const publication: any = {
    artifact_id: "doc",
    thread_id: "source",
    operation_id: "new",
    snapshot: { title: "Plan" },
  };
  openArtifact(
    { frameId: "chat", frameTreeActions: frames } as any,
    publication,
  );
  expect(frames.set_active_id).not.toHaveBeenCalled();
  expect(frames.move_frame).toHaveBeenCalledWith("latest", "history", "tab");
});

test.each([
  ["other-project", "/source.chat", false],
  ["source-project", "/other.chat", false],
  ["source-project", "/source.chat", true],
])(
  "artifact tab identity includes project %s and path %s",
  (project, path, reused) => {
    const frames: any = {
      get_frame_ids_in_order: () => ["tab"],
      _get_frame_type: () => "workbench",
      _get_frame_data: (_id, key) =>
        ({
          artifact: "doc",
          thread: "thread",
          origin: "destination",
          sourceProject: project,
          sourcePath: path,
        })[key],
      split_frame: jest.fn(() => "new-tab"),
      move_frame: jest.fn(),
      set_active_id: jest.fn(),
      set_frame_full: jest.fn(),
    };
    openArtifact(
      { frameId: "destination", frameTreeActions: frames } as any,
      {
        artifact_id: "doc",
        thread_id: "thread",
        operation_id: "op",
        snapshot: { title: "Document" },
      } as any,
      undefined,
      { project_id: "source-project", path: "/source.chat", agent_id: "agent" },
    );
    if (reused) {
      expect(frames.set_active_id).toHaveBeenCalledWith("tab");
      expect(frames.split_frame).not.toHaveBeenCalled();
    } else {
      expect(frames.split_frame).toHaveBeenCalledWith(
        "col",
        "destination",
        "workbench",
        expect.objectContaining({
          "data-sourceProject": "source-project",
          "data-sourcePath": "/source.chat",
          "data-sourceAgent": "agent",
        }),
      );
    }
  },
);
