import { saveAccountAppearance } from "./account-appearance";

const mockWait = jest.fn();
const mockClose = jest.fn();
const mockConnect = jest.fn();
const mockCall = jest.fn();
jest.mock("@cocalc/conat/core/client", () => ({
  connect: (...args) => mockConnect(...args),
}));
jest.mock("./call-hub", () => ({
  __esModule: true,
  default: (...args) => mockCall(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockWait.mockResolvedValue(undefined);
  mockCall.mockResolvedValue({});
  mockConnect.mockReturnValue({
    waitUntilSignedIn: mockWait,
    close: mockClose,
  });
});

test("routes an appearance-only merge to the authenticated account's home bay", async () => {
  await saveAccountAppearance(
    { account_id: "alice", home_bay_url: "https://bay-2.example.com" },
    "system",
  );
  expect(mockConnect).toHaveBeenCalledWith(
    expect.objectContaining({ address: "https://bay-2.example.com" }),
  );
  expect(mockWait).toHaveBeenCalled();
  expect(mockCall).toHaveBeenCalledWith(
    expect.objectContaining({
      account_id: "alice",
      name: "db.userQuery",
      args: [
        {
          query: {
            accounts: {
              account_id: "alice",
              other_settings: { appearance_theme: "system" },
            },
          },
          options: [],
        },
      ],
    }),
  );
  expect(mockClose).toHaveBeenCalledTimes(1);
});

test("failed authentication closes the temporary connection without writing", async () => {
  mockWait.mockRejectedValueOnce(Error("signed out"));
  await expect(
    saveAccountAppearance(
      { account_id: "alice", home_bay_url: "https://bay-2.example.com" },
      "dark",
    ),
  ).rejects.toThrow("signed out");
  expect(mockCall).not.toHaveBeenCalled();
  expect(mockClose).toHaveBeenCalledTimes(1);
});

test("a failed save is not reported as success", async () => {
  mockCall.mockResolvedValueOnce({ error: "failed" });
  await expect(
    saveAccountAppearance(
      { account_id: "alice", home_bay_url: "https://bay-2.example.com" },
      "light",
    ),
  ).rejects.toThrow("save failed");
  expect(mockClose).toHaveBeenCalledTimes(1);
});
