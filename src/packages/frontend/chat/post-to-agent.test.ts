import { movePostedMessageToAgent } from "./post-to-agent";

test("saves the new agent message before removing the posted note", async () => {
  const calls: string[] = [];
  const message = { post_only: true } as any;
  const actions = {
    sendChat: jest.fn(() => {
      calls.push("send");
      return "2026-09-24T00:00:00.000Z";
    }),
    syncdb: {
      save: jest.fn(async () => {
        calls.push("sync");
      }),
    },
    save_to_disk: jest.fn(async () => {
      calls.push("disk");
    }),
    deleteMessage: jest.fn(() => {
      calls.push("delete");
      return true;
    }),
  } as any;
  expect(
    await movePostedMessageToAgent({
      actions,
      message,
      threadId: "thread-1",
      content: "An idea for later",
    }),
  ).toBe("moved");
  expect(actions.sendChat).toHaveBeenCalledWith({
    input: "An idea for later",
    reply_thread_id: "thread-1",
    preserveSelectedThread: true,
  });
  expect(calls).toEqual(["send", "sync", "disk", "delete"]);
});

test("does not remove the note if sending or saving fails", async () => {
  const actions = {
    sendChat: jest.fn(() => ""),
    deleteMessage: jest.fn(),
    syncdb: { save: jest.fn() },
    save_to_disk: jest.fn(),
  } as any;
  expect(
    await movePostedMessageToAgent({
      actions,
      message: {} as any,
      threadId: "thread-1",
      content: "An idea for later",
    }),
  ).toBe("failed");
  expect(actions.deleteMessage).not.toHaveBeenCalled();
  actions.sendChat.mockReturnValue("2026-09-24T00:00:00.000Z");
  actions.syncdb.save.mockRejectedValue(new Error("save failed"));
  await expect(
    movePostedMessageToAgent({
      actions,
      message: {} as any,
      threadId: "thread-1",
      content: "An idea for later",
    }),
  ).rejects.toThrow("save failed");
  expect(actions.deleteMessage).not.toHaveBeenCalled();
});
