import { stream as persistStream } from "@cocalc/conat/persist/client";
import {
  assertCanonicalRoomHistoryBound,
  ROOM_HISTORY_MAX_PATCHES,
  ROOM_HISTORY_MAX_BYTES,
} from "./flush-history";
jest.mock("@cocalc/conat/persist/client", () => ({ stream: jest.fn() }));
const source = {
  client: {} as any,
  project_id: "project",
  path: "/canonical/collaborators.chat",
};
const stream = { inventory: jest.fn(), close: jest.fn() };
beforeEach(() => {
  jest.clearAllMocks();
  (persistStream as jest.Mock).mockReturnValue(stream);
});
test("metadata-only admission uses the supported inventory RPC and exact canonical project stream", async () => {
  stream.inventory.mockResolvedValue({
    count: ROOM_HISTORY_MAX_PATCHES,
    bytes: ROOM_HISTORY_MAX_BYTES,
  });
  await assertCanonicalRoomHistoryBound(source);
  expect(persistStream).toHaveBeenCalledWith({
    client: source.client,
    user: { project_id: source.project_id },
    storage: { path: "projects/project/patchflow" + source.path },
  });
  expect(stream.inventory).toHaveBeenCalledWith(10000);
  expect(stream.close).toHaveBeenCalledTimes(1);
});
test.each([
  { count: ROOM_HISTORY_MAX_PATCHES + 1, bytes: 1 },
  { count: 1, bytes: ROOM_HISTORY_MAX_BYTES + 1 },
  { count: 1, bytes: -1 },
  { count: null, bytes: 1 },
  { count: 1, bytes: "0" },
  undefined,
])(
  "oversized or malformed history never silently falls through: %j",
  async (inventory) => {
    stream.inventory.mockResolvedValue(inventory);
    await expect(assertCanonicalRoomHistoryBound(source)).rejects.toThrow(
      /capacity/,
    );
    expect(stream.close).toHaveBeenCalledTimes(1);
  },
);
test("failed metadata admission releases the handle", async () => {
  stream.inventory.mockRejectedValue(Error("unavailable"));
  await expect(assertCanonicalRoomHistoryBound(source)).rejects.toThrow(
    /unavailable/,
  );
  expect(stream.close).toHaveBeenCalledTimes(1);
});
