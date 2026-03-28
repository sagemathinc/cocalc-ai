/** @jest-environment jsdom */

import { parse_target } from "./history";

describe("parse_target", () => {
  it("recognizes account settings tabs on direct loads", () => {
    expect(parse_target("settings/vouchers")).toEqual({
      page: "account",
      tab: "vouchers",
      sub_tab: undefined,
    });
    expect(parse_target("settings/store")).toEqual({
      page: "account",
      tab: "store",
      sub_tab: undefined,
    });
    expect(parse_target("settings/payment-methods")).toEqual({
      page: "account",
      tab: "payment-methods",
      sub_tab: undefined,
    });
  });

  it("normalizes settings overview and profile routes to account routes", () => {
    expect(parse_target("settings")).toEqual({
      page: "account",
      tab: "index",
      sub_tab: undefined,
    });
    expect(parse_target("settings/index")).toEqual({
      page: "account",
      tab: "index",
      sub_tab: undefined,
    });
    expect(parse_target("settings/profile")).toEqual({
      page: "account",
      tab: "profile",
      sub_tab: undefined,
    });
  });

  it("recognizes admin news routes on direct loads", () => {
    expect(parse_target("admin/news")).toEqual({
      page: "admin",
      route: { kind: "news-list" },
    });
    expect(parse_target("admin/news/new?channel=event")).toEqual({
      page: "admin",
      route: { kind: "news-editor", id: "new" },
    });
  });
});
