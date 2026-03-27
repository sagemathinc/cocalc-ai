/** @jest-environment jsdom */

import { parse_target } from "./history";

describe("parse_target", () => {
  it("recognizes account settings tabs on direct loads", () => {
    expect(parse_target("settings/vouchers")).toEqual({
      page: "account",
      tab: "vouchers",
    });
    expect(parse_target("settings/store")).toEqual({
      page: "account",
      tab: "store",
    });
    expect(parse_target("settings/payment-methods")).toEqual({
      page: "account",
      tab: "payment-methods",
    });
  });

  it("keeps settings overview and profile routes distinct", () => {
    expect(parse_target("settings")).toEqual({ page: "settings" });
    expect(parse_target("settings/index")).toEqual({ page: "settings" });
    expect(parse_target("settings/profile")).toEqual({ page: "profile" });
  });
});
