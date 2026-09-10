import { EventEmitter } from "events";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { publishArtifact } from "@cocalc/chat";
import { ArtifactCards } from "../artifacts";

afterEach(() => jest.restoreAllMocks());

test("cards wait for SyncDB readiness and recover without a change event", () => {
  let state = "init";
  const rows: any[] = [];
  const syncdb = Object.assign(new EventEmitter(), {
    get_state: () => state,
    get_one: () => undefined,
    set: (row) => rows.push(...(Array.isArray(row) ? row : [row])),
    get: jest.fn(() => {
      if (state !== "ready") throw Error("must be ready -- get");
      return rows.filter((row) => row.event === "chat-artifact-publication");
    }),
  });
  publishArtifact(syncdb, {
    thread_id: "thread",
    artifact_id: "file",
    operation_id: "op",
    message_id: "message",
    title: "File",
    markdown: "",
    file: { path: "/plan.md" },
  });
  const { unmount } = render(
    <ArtifactCards
      actions={{ syncdb } as any}
      threadId="thread"
      messageId="message"
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading artifacts");
  expect(syncdb.get).not.toHaveBeenCalled();
  act(() => {
    state = "ready";
    syncdb.emit("ready");
  });
  expect(screen.getByText("/plan.md")).toBeTruthy();
  act(() => {
    state = "closed";
    syncdb.emit("closed");
  });
  expect(screen.getByRole("status")).toHaveTextContent("Loading artifacts");
  unmount();
  for (const event of ["ready", "closed", "change"])
    expect(syncdb.listenerCount(event)).toBe(0);
});

test.each([1024, 375])(
  "publication card preserves frames and opens appropriately at width %i",
  (width) => {
    jest.replaceProperty(window, "innerWidth", width);
    const records: any[] = [];
    const syncdb = Object.assign(new EventEmitter(), {
      get_one: () => undefined,
      set: (row) => records.push(...(Array.isArray(row) ? row : [row])),
      get: (where) =>
        records.filter((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        ),
    });
    const split_frame = jest.fn(() => "artifact-frame");
    const set_frame_full = jest.fn();
    const actions: any = {
      syncdb,
      frameId: "chat-frame",
      frameTreeActions: {
        split_frame,
        set_frame_full,
        get_frame_ids_in_order: () => [],
      },
    };
    const activateParent = jest.fn();
    render(
      <div onClick={activateParent}>
        <ArtifactCards
          actions={actions}
          threadId="thread-1"
          messageId="message-1"
        />
      </div>,
    );
    expect(screen.queryByRole("button", { name: "Open artifact" })).toBeNull();
    act(() => {
      publishArtifact(syncdb, {
        thread_id: "thread-1",
        artifact_id: "doc-1",
        operation_id: "op-1",
        message_id: "message-1",
        title: "Replies",
        markdown: "Hello",
      });
      syncdb.emit("change");
    });
    const button = screen.getByRole("button", { name: "Open artifact" });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(activateParent).not.toHaveBeenCalled();
    expect(split_frame).toHaveBeenCalledWith("col", "chat-frame", "workbench", {
      "data-artifact": "doc-1",
      "data-thread": "thread-1",
      "data-origin": "chat-frame",
      "data-publication": "op-1",
      "data-tabLabel": "Replies",
    });
    expect(screen.getByText("Hello")).toBeTruthy();
    if (width < 768)
      expect(set_frame_full).toHaveBeenCalledWith("artifact-frame");
    else expect(set_frame_full).not.toHaveBeenCalled();
    const published = screen.getByRole("button", { name: "Published version" });
    published.focus();
    expect(document.activeElement).toBe(published);
    fireEvent.click(published);
    expect(split_frame).toHaveBeenLastCalledWith(
      "col",
      "chat-frame",
      "workbench",
      {
        "data-artifact": "doc-1",
        "data-thread": "thread-1",
        "data-origin": "chat-frame",
        "data-publication": "op-1",
        "data-version": "op-1",
        "data-tabLabel": "Replies (published)",
      },
    );
    expect(activateParent).not.toHaveBeenCalled();
  },
);

test.each([
  ["same artifact", "doc-1", "thread-1", "chat-frame", true],
  ["different artifact", "doc-2", "thread-1", "chat-frame", false],
  ["different thread", "doc-1", "thread-2", "chat-frame", false],
  ["different origin", "doc-1", "thread-1", "other-chat-frame", false],
])(
  "opening a card preserves an existing %s frame",
  (_name, artifact, thread, origin, reuse) => {
    const rows: any[] = [];
    const syncdb = Object.assign(new EventEmitter(), {
      get_one: () => undefined,
      set: (row) => rows.push(...(Array.isArray(row) ? row : [row])),
      get: (where) =>
        rows.filter((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        ),
    });
    publishArtifact(syncdb, {
      thread_id: "thread-1",
      artifact_id: "doc-1",
      operation_id: "publication-1",
      message_id: "message-1",
      title: "Replies",
      markdown: "Published text",
    });
    const existing = { artifact, thread, origin, version: "old-publication" };
    const frames = {
      _get_frame_type: (id) =>
        id === "existing-artifact" ? "workbench" : "terminal",
      move_frame: jest.fn(),
      get_frame_ids_in_order: () => ["terminal", "existing-artifact"],
      _get_frame_data: (id, key) =>
        id === "existing-artifact" ? existing[key] : undefined,
      set_active_id: jest.fn(),
      set_frame_data: jest.fn(),
      split_frame: jest.fn(() => "new-artifact"),
      set_frame_full: jest.fn(),
      close_frame: jest.fn(),
    };
    render(
      <ArtifactCards
        actions={
          { syncdb, frameId: "chat-frame", frameTreeActions: frames } as any
        }
        threadId="thread-1"
        messageId="message-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open artifact" }));
    if (reuse) {
      expect(frames.move_frame).not.toHaveBeenCalled();
      expect(frames.set_active_id).toHaveBeenCalledWith("existing-artifact");
      expect(frames.split_frame).not.toHaveBeenCalled();
    } else {
      expect(frames.move_frame).toHaveBeenCalledWith(
        "new-artifact",
        "existing-artifact",
        "tab",
      );
      expect(frames.split_frame).toHaveBeenCalledWith(
        "col",
        "chat-frame",
        "workbench",
        expect.objectContaining({
          "data-artifact": "doc-1",
          "data-thread": "thread-1",
          "data-origin": "chat-frame",
        }),
      );
      expect(frames.set_active_id).not.toHaveBeenCalled();
    }
    // Focusing a frame must not reset its revision, remount its editor, or close a terminal.
    expect(frames.set_frame_data).not.toHaveBeenCalled();
    expect(frames.close_frame).not.toHaveBeenCalled();
    expect(existing.version).toBe("old-publication");
    frames.split_frame.mockClear();
    frames.set_active_id.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Published version" }));
    expect(frames.split_frame).toHaveBeenCalledWith(
      "col",
      "chat-frame",
      "workbench",
      expect.objectContaining({
        "data-version": "publication-1",
      }),
    );
    expect(frames.set_frame_data).not.toHaveBeenCalled();
    expect(existing.version).toBe("old-publication");
    if (reuse) {
      // A matching snapshot may be focused, but a different view is never repurposed.
      existing.version = "publication-1";
      frames.split_frame.mockClear();
      fireEvent.click(
        screen.getByRole("button", { name: "Published version" }),
      );
      expect(frames.split_frame).not.toHaveBeenCalled();
      expect(frames.set_active_id).toHaveBeenCalledWith("existing-artifact");
    }
  },
);
