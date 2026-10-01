import getCustomize from "./customize";
import { getServerSettings } from "./server-settings";

jest.mock("./server-settings", () => ({ getServerSettings: jest.fn() }));
jest.mock("@cocalc/database/settings/get-sso-strategies", () => ({
  __esModule: true,
  default: async () => [],
}));
jest.mock("./site-url", () => ({
  __esModule: true,
  default: async () => "https://example.test",
}));

test("host discovery can read the processed rollout flag without other settings", async () => {
  (getServerSettings as jest.Mock).mockResolvedValue({
    collaborators_enabled: true,
    openai_api_key: "not-public",
  });
  expect(await getCustomize(["collaborators_enabled"])).toEqual({
    collaborators_enabled: true,
  });
  (getServerSettings as jest.Mock).mockResolvedValue({});
  expect(await getCustomize(["collaborators_enabled"])).toEqual({
    collaborators_enabled: false,
  });
});
