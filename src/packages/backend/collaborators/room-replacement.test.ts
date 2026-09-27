import { replaceCanonicalRoom } from "./room-replacement";
import { planCollaborationRoomReplacement } from "@cocalc/util/collaboration-room-replacement";

const project_id = "11111111-1111-4111-8111-111111111111";
const account_id = "22222222-2222-4222-8222-222222222222";
const host_id = "33333333-3333-4333-8333-333333333333";
const room_id = "44444444-4444-4444-8444-444444444444";
const request_id = "55555555-5555-4555-8555-555555555555";
const chat_path = "/home/user/.cocalc/collaborators.chat";
function fixture() {
  const room = { project_id, room_id, chat_path, initialized: true };
  const request = {
    version: 1 as const,
    project_id,
    request_id,
    expected_room_id: room_id,
    expected_chat_path: chat_path,
  };
  let locked = false;
  const options = {
    request,
    identity: { project_id, account_id },
    host_id,
    assertCurrent: jest.fn(),
    withSourceLock: async <T>(run: () => Promise<T>): Promise<T> => {
      locked = true;
      try {
        return await run();
      } finally {
        locked = false;
      }
    },
    currentRoom: jest.fn(async () => room),
    sourceEpoch: jest.fn(async (): Promise<string | null> => null),
    lstat: jest.fn(async () => {
      throw Object.assign(Error("missing"), { code: "ENOENT" });
    }),
    commit: jest.fn(async (absence) => {
      expect(locked).toBe(true);
      const plan = planCollaborationRoomReplacement({
        request,
        authority: {
          project_id,
          requesting_account_id: account_id,
          requester_role: "owner",
          authenticated_host_id: host_id,
          current_host_id: host_id,
        },
        current_room: room,
        current_source_epoch: null,
        receipt: null,
        absence,
        retained_operations: 0,
      });
      if (plan.action !== "commit") throw Error("unexpected replay");
      return {
        outcome: "pending" as const,
        operation_id: plan.receipt.operation_id,
        room: plan.room,
      };
    }),
    transition: jest.fn(),
  };
  return options;
}

test("confirmed absence binds the authenticated human, host, request and source under the lock", async () => {
  const options = fixture();
  const result = await replaceCanonicalRoom(options);
  expect(options.commit).toHaveBeenCalledWith({
    status: "missing",
    project_id,
    requesting_account_id: account_id,
    host_id,
    request_id,
    room_id,
    chat_path,
    source_epoch: null,
  });
  expect(options.transition).toHaveBeenCalledWith(
    await options.currentRoom(),
    result.outcome !== "superseded" && result.room,
  );
});
test.each(["EACCES", "ENOTDIR", "EIO", undefined])(
  "a filesystem error %s never authorizes replacement",
  async (code) => {
    const options = fixture();
    options.lstat.mockRejectedValue(
      Object.assign(Error("read failed"), { code }),
    );
    await expect(replaceCanonicalRoom(options)).rejects.toThrow("read failed");
    expect(options.commit).not.toHaveBeenCalled();
    expect(options.transition).not.toHaveBeenCalled();
  },
);
test("an existing file, corrupt file, directory or symlink cannot be replaced", async () => {
  const options = fixture();
  options.lstat.mockResolvedValue({} as never);
  await expect(replaceCanonicalRoom(options)).rejects.toThrow("still exists");
  expect(options.commit).not.toHaveBeenCalled();
});
test("a committed retry does not test or recreate the retired locator", async () => {
  const options = fixture();
  const result = await replaceCanonicalRoom(options);
  options.currentRoom.mockResolvedValue(
    result.outcome !== "superseded" ? result.room : (null as never),
  );
  options.commit.mockResolvedValue(result as any);
  options.lstat.mockClear().mockResolvedValue({} as never);
  options.sourceEpoch.mockClear();
  expect(await replaceCanonicalRoom(options)).toEqual(result);
  expect(options.commit).toHaveBeenLastCalledWith(undefined);
  expect(options.lstat).not.toHaveBeenCalled();
  expect(options.sourceEpoch).not.toHaveBeenCalled();
});
test("superseded receipt never transitions or initializes a retired replacement", async () => {
  const options = fixture();
  const first = await replaceCanonicalRoom(options);
  options.currentRoom.mockResolvedValue({
    project_id,
    room_id: host_id,
    chat_path,
    initialized: true,
  });
  options.commit.mockResolvedValue({
    outcome: "superseded",
    operation_id: first.operation_id,
    replacement_room_id: room_id,
  } as any);
  options.transition.mockClear();
  expect((await replaceCanonicalRoom(options)).outcome).toBe("superseded");
  expect(options.transition).not.toHaveBeenCalled();
});
test("lost owner acknowledgement cannot transition local room state", async () => {
  const options = fixture();
  options.commit.mockRejectedValue(Error("unknown outcome"));
  await expect(replaceCanonicalRoom(options)).rejects.toThrow(
    "unknown outcome",
  );
  expect(options.transition).not.toHaveBeenCalled();
});
test("placement/lifecycle change after lstat prevents the owner write", async () => {
  const options = fixture();
  options.lstat.mockImplementation(async () => {
    options.assertCurrent.mockImplementation(() => {
      throw Error("lifecycle changed");
    });
    throw Object.assign(Error("missing"), { code: "ENOENT" });
  });
  await expect(replaceCanonicalRoom(options)).rejects.toThrow(
    "lifecycle changed",
  );
  expect(options.commit).not.toHaveBeenCalled();
});
test("wrong project fails before filesystem observation", async () => {
  const options = fixture();
  options.identity.project_id = account_id;
  await expect(replaceCanonicalRoom(options)).rejects.toThrow(
    "identity mismatch",
  );
  expect(options.lstat).not.toHaveBeenCalled();
});
