import { withSessionAdvisoryLock } from "@cocalc/database/pool";
import {
  withAccountRehomeAttemptLock,
  withCollaborationCopyLock,
} from "./collaboration-account-rehome";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => {
    throw Error("protocol lock must not occupy the application pool");
  }),
  withSessionAdvisoryLock: jest.fn(),
}));

const lock = withSessionAdvisoryLock as jest.Mock;
beforeEach(() => lock.mockReset());

test("source attempts use a dedicated session and a separate namespace from destination copy", async () => {
  lock.mockImplementation(async ({ fn }) => fn());
  await expect(
    withAccountRehomeAttemptLock("operation", async () => "source"),
  ).resolves.toBe("source");
  await expect(
    withCollaborationCopyLock("account", async () => undefined),
  ).resolves.toBeUndefined();
  expect(lock.mock.calls.map(([opts]) => opts.lockKey)).toEqual([
    "account-rehome-attempt:operation",
    "collaboration-rehome-copy:account",
  ]);
});

test("a concurrent retry fails without running or marking another attempt failed", async () => {
  lock.mockResolvedValue(undefined);
  const work = jest.fn();
  await expect(withAccountRehomeAttemptLock("operation", work)).rejects.toThrow(
    "already in progress",
  );
  await expect(withCollaborationCopyLock("account", work)).rejects.toThrow(
    "already in progress",
  );
  expect(work).not.toHaveBeenCalled();
});

test("an interrupted copy propagates failure for durable forward reconciliation", async () => {
  lock.mockImplementation(async ({ fn }) => fn());
  await expect(
    withCollaborationCopyLock("account", async () => {
      throw Error("copy failed");
    }),
  ).rejects.toThrow("copy failed");
});
