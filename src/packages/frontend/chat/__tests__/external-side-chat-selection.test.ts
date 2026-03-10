/** @jest-environment jsdom */

import {
  getExternalSideChatDesc,
  persistExternalSideChatSelectedThreadKey,
} from "../external-side-chat-selection";

jest.mock("@cocalc/frontend/editor-local-storage", () => ({
  local_storage: jest.fn(),
  local_storage_delete: jest.fn(),
}));

const { local_storage } = jest.requireMock(
  "@cocalc/frontend/editor-local-storage",
);
const { local_storage_delete } = jest.requireMock(
  "@cocalc/frontend/editor-local-storage",
);

describe("external side chat thread persistence", () => {
  beforeEach(() => {
    local_storage.mockReset();
    local_storage_delete.mockReset();
  });

  it("restores a persisted selected thread for external side chat", () => {
    local_storage.mockReturnValue("thread-123");

    expect(getExternalSideChatDesc("project-1", "notes.ipynb")).toEqual({
      "data-selectedThreadKey": "thread-123",
      "data-preferLatestThread": false,
    });
    expect(local_storage).toHaveBeenCalledWith(
      "project-1",
      "notes.ipynb",
      "selectedThreadKey",
    );
  });

  it("persists selected threads against the original host file path", () => {
    persistExternalSideChatSelectedThreadKey({
      project_id: "project-1",
      path: ".notes.ipynb.sage-chat",
      selectedThreadKey: "thread-123",
    });

    expect(local_storage).toHaveBeenCalledWith(
      "project-1",
      "notes.ipynb",
      "selectedThreadKey",
      "thread-123",
    );
  });

  it("clears persisted selection when returning to the combined feed", () => {
    persistExternalSideChatSelectedThreadKey({
      project_id: "project-1",
      path: ".notes.ipynb.sage-chat",
      selectedThreadKey: null,
    });

    expect(local_storage_delete).toHaveBeenCalledWith(
      "project-1",
      "notes.ipynb",
      "selectedThreadKey",
    );
  });
});
