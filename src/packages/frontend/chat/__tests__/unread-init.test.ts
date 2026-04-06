import {
  ensureSideChatActions,
  getExistingSideChatActions,
  getSideChatPath,
} from "../unread";
import { getChatActions, initChat } from "../register";

jest.mock("../register", () => ({
  getChatActions: jest.fn(),
  initChat: jest.fn(),
}));

describe("chat unread initialization helpers", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns only existing side-chat actions without initializing a store", () => {
    const existing = { id: "existing-chat-actions" } as any;
    (getChatActions as jest.Mock).mockReturnValue(existing);

    expect(getExistingSideChatActions("project-1", "notes.md")).toBe(existing);
    expect(getChatActions).toHaveBeenCalledWith(
      "project-1",
      getSideChatPath("notes.md"),
    );
    expect(initChat).not.toHaveBeenCalled();
  });

  it("initializes side-chat actions on demand when explicitly requested", () => {
    const created = { id: "created-chat-actions" } as any;
    (getChatActions as jest.Mock).mockReturnValue(undefined);
    (initChat as jest.Mock).mockReturnValue(created);

    expect(ensureSideChatActions("project-1", "notes.md")).toBe(created);
    expect(initChat).toHaveBeenCalledWith(
      "project-1",
      getSideChatPath("notes.md"),
    );
  });
});
