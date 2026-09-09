import { EventEmitter } from "events";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { publishArtifact } from "@cocalc/chat";
import { ArtifactCards } from "../artifacts";

afterEach(() => jest.restoreAllMocks());

test.each([1024, 375])(
  "publication card preserves frames and opens appropriately at width %i",
  (width) => {
    jest.replaceProperty(window, "innerWidth", width);
    const records: any[] = [];
    const syncdb = Object.assign(new EventEmitter(), {
      get_one: () => undefined,
      set: (row) => records.push(row),
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
    });
    expect(screen.getByText("Hello")).toBeTruthy();
    if (width < 768)
      expect(set_frame_full).toHaveBeenCalledWith("artifact-frame");
    else expect(set_frame_full).not.toHaveBeenCalled();
  },
);
