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
