import {
  getInitialAccountPageState,
  getPageTopTab,
  parsePageTarget,
} from "./page-routing";

describe("page-routing", () => {
  it("maps settings routes to the account top tab", () => {
    const parsed = parsePageTarget("settings/vouchers");
    expect(parsed).toEqual({
      page: "account",
      tab: "vouchers",
      sub_tab: undefined,
    });
    expect(getPageTopTab(parsed)).toBe("account");
    expect(getInitialAccountPageState(parsed)).toEqual({
      active_page: "vouchers",
      active_sub_tab: undefined,
    });
  });

  it("keeps projects and project targets distinct", () => {
    expect(parsePageTarget("projects")).toEqual({ page: "projects" });
    expect(parsePageTarget("projects/abc/files")).toEqual({
      page: "project",
      target: "abc/files",
    });
  });

  it("normalizes settings overview and preferences routes", () => {
    expect(parsePageTarget("settings")).toEqual({
      page: "account",
      tab: "index",
      sub_tab: undefined,
    });
    expect(parsePageTarget("settings/profile")).toEqual({
      page: "account",
      tab: "profile",
      sub_tab: undefined,
    });
    expect(parsePageTarget("settings/preferences/editor")).toEqual({
      page: "account",
      tab: "preferences",
      sub_tab: "preferences-editor",
    });
  });
});
