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
