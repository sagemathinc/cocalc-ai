import { saveAccountAppearance } from "./appearance-account";
import { saveAccountAppearance as save } from "@cocalc/conat/hub/account-appearance";

jest.mock("@cocalc/conat/hub/account-appearance", () => ({
  saveAccountAppearance: jest.fn().mockResolvedValue(undefined),
}));

test("passes the Essential installation prefix to the account transport", async () => {
  const previous = window.location.pathname;
  window.history.replaceState(null, "", "/prefix/essential/projects");
  try {
    const account = {
      account_id: "alice",
      home_bay_url: "https://bay-2.example.com",
    };
    await saveAccountAppearance(account, "dark");
    expect(save).toHaveBeenCalledWith(account, "dark", "/prefix");
  } finally {
    window.history.replaceState(null, "", previous);
  }
});
