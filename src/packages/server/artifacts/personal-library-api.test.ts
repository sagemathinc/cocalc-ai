import { createHash, randomUUID } from "node:crypto";
import { personalLibraryApi } from "./personal-library-api";

const home = jest.fn();
const entry = jest.fn();
const account_id = randomUUID();
const project_id = randomUUID();
const pin_key = JSON.stringify([
  project_id,
  "/home/user/example.chat",
  "thread",
  "artifact",
]);
const entry_id = createHash("sha256").update(pin_key).digest("hex");
const snapshot = { aliases: [], pins: [pin_key] };
const setPinned = jest.fn();

jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args) => home(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
}));
jest.mock("@cocalc/server/artifacts/catalog-api", () => ({
  getEntry: (...args) => entry(...args),
}));
jest.mock("./personal-library-store", () => ({
  personalLibraryStore: { setPinned: (...args) => setPinned(...args) },
}));

beforeEach(() => {
  jest.clearAllMocks();
  home.mockResolvedValue({ home_bay_id: "home" });
  entry.mockResolvedValue({
    project_id,
    entry_id,
    chat_path: "/home/user/example.chat",
    item: { thread_id: "thread", artifact_id: "artifact" },
  });
  setPinned.mockResolvedValue(snapshot);
});

test("pinning verifies an authorized, current catalog entry before writing", async () => {
  await expect(
    personalLibraryApi.setPinned({ account_id, pin_key, pinned: true }),
  ).resolves.toEqual(snapshot);
  expect(entry).toHaveBeenCalledWith({ account_id, project_id, entry_id });
  expect(entry.mock.invocationCallOrder[0]).toBeLessThan(
    setPinned.mock.invocationCallOrder[0],
  );
});

test("missing, mismatched, denied and malformed entries cannot create pins", async () => {
  entry.mockResolvedValueOnce(null);
  await expect(
    personalLibraryApi.setPinned({ account_id, pin_key, pinned: true }),
  ).rejects.toThrow("Artifact unavailable");
  entry.mockResolvedValueOnce({
    chat_path: "/other.chat",
    item: { thread_id: "thread", artifact_id: "artifact" },
  });
  await expect(
    personalLibraryApi.setPinned({ account_id, pin_key, pinned: true }),
  ).rejects.toThrow("Artifact unavailable");
  entry.mockRejectedValueOnce(Error("not a collaborator"));
  await expect(
    personalLibraryApi.setPinned({ account_id, pin_key, pinned: true }),
  ).rejects.toThrow("not a collaborator");
  await expect(
    personalLibraryApi.setPinned({ account_id, pin_key: "bad", pinned: true }),
  ).rejects.toThrow("Invalid artifact pin");
  expect(setPinned).not.toHaveBeenCalled();
});

test("unpinning does not require a still-live catalog entry", async () => {
  await personalLibraryApi.setPinned({ account_id, pin_key, pinned: false });
  expect(entry).not.toHaveBeenCalled();
  expect(setPinned).toHaveBeenCalledWith({
    account_id,
    pin_key,
    pinned: false,
  });
});
