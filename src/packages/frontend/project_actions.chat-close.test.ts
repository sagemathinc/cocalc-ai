import * as misc from "@cocalc/util/misc";

jest.mock("@cocalc/frontend/chat/register", () => ({
  initChat: jest.fn(),
  remove: jest.fn(),
}));

import { redux } from "@cocalc/frontend/app-framework";
import { remove as removeChatRuntime } from "@cocalc/frontend/chat/register";
import { ProjectActions } from "./project_actions";

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
});
