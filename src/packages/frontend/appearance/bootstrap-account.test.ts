import { receiveAppearanceBootstrap } from "./bootstrap-account";
import { createAppearanceStore } from "@cocalc/util/appearance-store";
import { saveAccountAppearance } from "@cocalc/conat/hub/account-appearance";

let mockStore: ReturnType<typeof createAppearanceStore>;
jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/prefix",
}));
jest.mock("@cocalc/util/appearance-browser", () => ({
  getBrowserAppearanceStore: () => mockStore,
}));
jest.mock("@cocalc/conat/hub/account-appearance", () => ({
  saveAccountAppearance: jest.fn(),
}));

beforeEach(() => {
  mockStore = createAppearanceStore();
  jest.mocked(saveAccountAppearance).mockReset().mockResolvedValue(undefined);
});

test("existing bootstrap hydrates appearance without a theme request or write", async () => {
  receiveAppearanceBootstrap({
    signed_in: true,
    account_id: "alice",
    home_bay_url: "https://bay-2.example.com",
    appearance_theme: "dark",
  });
  expect(mockStore.getSnapshot().preference).toBe("dark");
  expect(saveAccountAppearance).not.toHaveBeenCalled();
  await mockStore.choose("system");
  expect(saveAccountAppearance).toHaveBeenCalledWith(
    { account_id: "alice", home_bay_url: "https://bay-2.example.com" },
    "system",
    "/prefix",
  );
});

test("signing out removes the account writer and restores visitor mode", async () => {
  receiveAppearanceBootstrap({
    signed_in: true,
    account_id: "alice",
    home_bay_url: "https://bay-2.example.com",
    appearance_theme: "dark",
  });
  receiveAppearanceBootstrap({ signed_in: false });
  expect(mockStore.getSnapshot().preference).toBe("system");
  await mockStore.choose("light");
  expect(saveAccountAppearance).not.toHaveBeenCalled();
});
