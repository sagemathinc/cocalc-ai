import {
  getInitialAccountPageState,
  getPageTargetPath,
  getPageTopTab,
  getPageUrlPath,
  parsePageTarget,
} from "./page-routing";

describe("page-routing", () => {
  it("maps settings routes to the account top tab", () => {
    const parsed = parsePageTarget("settings/vouchers");
    expect(parsed).toEqual({
      page: "account",
      tab: "vouchers",
    });
    expect(getPageTopTab(parsed)).toBe("account");
    expect(getInitialAccountPageState(parsed)).toEqual({
      active_page: "vouchers",
    });
  });

  it("keeps projects and project targets distinct", () => {
    expect(parsePageTarget("projects")).toEqual({ page: "projects" });
    expect(parsePageTarget("projects/abc/files")).toEqual({
      page: "project",
      target: "abc/files",
    });
  });

  it("parses auth and ssh routes explicitly", () => {
    expect(parsePageTarget("auth/password-reset")).toEqual({
      page: "auth",
      view: "password-reset",
    });
    expect(parsePageTarget("ssh")).toEqual({ page: "ssh" });
  });

  it("parses global docs routes", () => {
    expect(parsePageTarget("app-docs")).toEqual({ page: "docs" });
    expect(parsePageTarget("app-docs/admin/users")).toEqual({
      page: "docs",
      slug: "admin/users",
    });
    expect(parsePageTarget("app-docs/print")).toEqual({
      page: "docs",
      print: true,
    });
    expect(getPageTopTab(parsePageTarget("app-docs/admin/users"))).toBe("docs");
  });

  it("parses admin subroutes and ignores query strings", () => {
    expect(parsePageTarget("admin/news")).toEqual({
      page: "admin",
      route: { kind: "news-list" },
    });
    expect(parsePageTarget("admin/news/new?channel=event")).toEqual({
      page: "admin",
      route: { kind: "news-editor", id: "new" },
    });
  });

  it("normalizes settings overview and preferences routes", () => {
    expect(parsePageTarget("settings")).toEqual({
      page: "account",
      tab: "index",
    });
    expect(parsePageTarget("settings/profile")).toEqual({
      page: "account",
      tab: "profile",
    });
    expect(parsePageTarget("settings/editor")).toEqual({
      page: "account",
      tab: "editor",
    });
    expect(parsePageTarget("settings/billing")).toEqual({
      page: "account",
      tab: "subscriptions",
    });
  });

  it("maps legacy billing and store aliases onto canonical settings pages", () => {
    expect(parsePageTarget("billing/cards")).toEqual({
      page: "account",
      tab: "payment-methods",
    });
    expect(parsePageTarget("billing/receipts")).toEqual({
      page: "account",
      tab: "statements",
    });
    expect(parsePageTarget("store/membership")).toEqual({
      page: "account",
      tab: "store",
    });
    expect(parsePageTarget("store/vouchers")).toEqual({
      page: "account",
      tab: "store",
    });
  });

  it("builds canonical paths from shared page routes", () => {
    expect(getPageTargetPath({ page: "projects" })).toBe("projects");
    expect(
      getPageTargetPath({
        page: "account",
        tab: "keyboard",
      }),
    ).toBe("settings/keyboard");
    expect(getPageUrlPath({ page: "auth", view: "sign-up" })).toBe(
      "/auth/sign-up",
    );
    expect(getPageUrlPath({ page: "docs", slug: "admin/users" })).toBe(
      "/app-docs/admin/users",
    );
    expect(getPageUrlPath({ page: "docs", print: true })).toBe(
      "/app-docs/print",
    );
    expect(
      getPageUrlPath({
        page: "admin",
        route: { kind: "news-editor", id: "17" },
      }),
    ).toBe("/admin/news/17");
    expect(getPageUrlPath({ page: "project", target: "abc/files" })).toBe(
      "/projects/abc/files",
    );
  });
});
