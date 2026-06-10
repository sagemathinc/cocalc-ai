import { fromJS } from "immutable";

import {
  getAdminTargetPath,
  normalizeAdminRoute,
  parseAdminRoute,
} from "./routing";

describe("admin routing", () => {
  it("parses news editor routes", () => {
    expect(parseAdminRoute("admin/news/new")).toEqual({
      kind: "news-editor",
      id: "new",
    });
    expect(parseAdminRoute("admin/site-settings")).toEqual({
      kind: "index",
      section: "site-settings",
    });
    expect(parseAdminRoute("admin/site-setup")).toEqual({
      kind: "index",
      section: "site-setup",
    });
    expect(parseAdminRoute("admin/managed-cpu")).toEqual({
      kind: "index",
      section: "managed-cpu",
    });
    expect(parseAdminRoute("admin/usage-stats")).toEqual({
      kind: "index",
      section: "usage-stats",
    });
    expect(getAdminTargetPath({ kind: "index", section: "user-search" })).toBe(
      "admin/user-search",
    );
  });

  it("normalizes immutable admin routes from redux state", () => {
    const route = fromJS({ kind: "news-editor", id: "new" });
    expect(normalizeAdminRoute(route)).toEqual({
      kind: "news-editor",
      id: "new",
    });
    expect(getAdminTargetPath(route)).toBe("admin/news/new");
  });
});
