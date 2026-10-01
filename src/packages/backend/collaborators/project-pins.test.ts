import { randomUUID } from "node:crypto";
import { akv } from "@cocalc/conat/sync/akv";
import { stream as persistStream } from "@cocalc/conat/persist/client";
import {
  accountProjectPins,
  projectPinIds,
  PROJECT_PIN_LIMIT,
} from "./project-pins";

jest.mock("@cocalc/conat/sync/akv", () => ({ akv: jest.fn() }));
jest.mock("@cocalc/conat/persist/client", () => ({ stream: jest.fn() }));
const first = randomUUID();
const second = randomUUID();
const store = {
  get: jest.fn(),
  getMessage: jest.fn(),
  set: jest.fn(),
  close: jest.fn(),
};
beforeEach(() => {
  jest.resetAllMocks();
  (akv as jest.Mock).mockReturnValue(store);
});
test("reads only the existing account favorites key and closes the handle", async () => {
  store.get.mockResolvedValue([first, first, second]);
  const client = {} as any;
  const pins = accountProjectPins(client, "account");
  expect(await pins.read()).toEqual([first, second]);
  expect(akv).toHaveBeenCalledWith({
    client,
    account_id: "account",
    name: "bookmarks",
  });
  expect(store.get).toHaveBeenCalledWith("projects", { timeout: 5000 });
  expect(store.close).toHaveBeenCalledTimes(1);
});
test("CAS retries preserve simultaneous edits to other favorites", async () => {
  store.getMessage
    .mockResolvedValueOnce({ data: [], headers: { seq: 7 } })
    .mockResolvedValueOnce({ data: [second], headers: { seq: 8 } });
  store.set.mockRejectedValueOnce(
    Object.assign(Error("conflict"), { code: "wrong-last-sequence" }),
  );
  await accountProjectPins({} as any, "account").set(first, true);
  expect(
    store.set.mock.calls.map(([key, value, opts]) => [
      key,
      value,
      opts.previousSeq,
    ]),
  ).toEqual([
    ["projects", [first], 7],
    ["projects", [first, second], 8],
  ]);
  expect(store.close).toHaveBeenCalledTimes(1);
});
test("unpin preserves ordering and repeated desired state does not write", async () => {
  store.getMessage.mockResolvedValue({
    data: [second, first],
    headers: { seq: 2 },
  });
  const pins = accountProjectPins({} as any, "account");
  await pins.set(first, true);
  expect(store.set).not.toHaveBeenCalled();
  await pins.set(first, false);
  expect(store.set).toHaveBeenCalledWith(
    "projects",
    [second],
    expect.objectContaining({ previousSeq: 2 }),
  );
});
test("no implicit retry on unknown write outcome, and conflict retries are bounded", async () => {
  store.getMessage.mockResolvedValue(undefined);
  store.set.mockRejectedValueOnce(Error("timeout"));
  await expect(
    accountProjectPins({} as any, "account").set(first, true),
  ).rejects.toThrow("timeout");
  expect(store.set).toHaveBeenCalledTimes(1);
  store.set
    .mockClear()
    .mockRejectedValue(
      Object.assign(Error("conflict"), { code: "wrong-last-sequence" }),
    );
  await expect(
    accountProjectPins({} as any, "account").set(first, true),
  ).rejects.toThrow("concurrently");
  expect(store.set).toHaveBeenCalledTimes(4);
});
test("malformed and oversized legacy arrays fail visibly rather than claim complete empty pins", () => {
  expect(projectPinIds(undefined)).toEqual([]);
  expect(() => projectPinIds({})).toThrow("Invalid");
  expect(() => projectPinIds(["not-a-project"])).toThrow("Invalid");
  expect(() => projectPinIds(Array(PROJECT_PIN_LIMIT + 1).fill(first))).toThrow(
    "limit",
  );
});

test("revision polling uses account-scoped metadata, never downloads the favorites list", async () => {
  const inventory = jest.fn().mockResolvedValue({ seq: 7 });
  const close = jest.fn();
  (persistStream as jest.Mock).mockReturnValue({ inventory, close });
  const client = {} as any;
  expect(await accountProjectPins(client, "account").revision()).toBe("7");
  expect(persistStream).toHaveBeenCalledWith({
    client,
    user: { account_id: "account" },
    storage: { path: "accounts/account/bookmarks" },
  });
  expect(inventory).toHaveBeenCalledWith(5000);
  expect(akv).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
  inventory.mockResolvedValue({ seq: "bad" });
  await expect(
    accountProjectPins(client, "account").revision(),
  ).rejects.toThrow("revision");
  expect(close).toHaveBeenCalledTimes(2);
});
