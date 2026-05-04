import * as misc from "@cocalc/util/misc";

jest.mock("@cocalc/frontend/chat/register", () => ({
  initChat: jest.fn(),
  remove: jest.fn(),
}));

import { redux } from "@cocalc/frontend/app-framework";
import { remove as removeChatRuntime } from "@cocalc/frontend/chat/register";
import { ProjectActions } from "./project_actions";
import * as project_file from "@cocalc/frontend/project-file";
import { Map as ImmutableMap } from "immutable";

describe("ProjectActions.close_chat", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (redux.getEditorActions as any) = jest.fn(() => undefined);
  });

  it("tears down the external side-chat runtime when closing legacy side chat", () => {
    const fakeActions = {
      project_id: "project-1",
      redux: { kind: "redux" },
      get_sync_path: jest.fn(() => "/home/user/notes.md"),
      set_chat_state: jest.fn(),
      open_chat: jest.fn(),
    } as any;

    ProjectActions.prototype.close_chat.call(fakeActions, {
      path: "/home/user/notes.md",
    });

    expect(removeChatRuntime).toHaveBeenCalledWith(
      misc.meta_file("/home/user/notes.md", "chat"),
      fakeActions.redux,
      "project-1",
    );
    expect(fakeActions.set_chat_state).toHaveBeenCalledWith(
      "/home/user/notes.md",
      "",
    );
  });

  it("tears down external side-chat runtimes when all files close", () => {
    const fakeActions = {
      project_id: "project-1",
      redux: { kind: "redux" },
      get_store: jest.fn(() => ({
        get: (key: string) =>
          key === "open_files"
            ? ImmutableMap({
                "/home/user/notes.md": ImmutableMap({
                  chatState: "external",
                }),
              })
            : undefined,
      })),
      get_sync_path: jest.fn(() => "/home/user/notes.md"),
      open_files: {
        close_all: jest.fn(),
      },
    } as any;

    const removeFileRuntime = jest
      .spyOn(project_file, "remove")
      .mockImplementation(() => {});

    ProjectActions.prototype.close_all_files.call(fakeActions);

    expect(removeFileRuntime).toHaveBeenCalledWith(
      "/home/user/notes.md",
      fakeActions.redux,
      "project-1",
    );
    expect(removeChatRuntime).toHaveBeenCalledWith(
      misc.meta_file("/home/user/notes.md", "chat"),
      fakeActions.redux,
      "project-1",
    );
    expect(fakeActions.open_files.close_all).toHaveBeenCalled();
  });
});
