import { fromJS } from "immutable";
import { searchableProjects } from "./searchable-projects";

test("searchable projects: recent first, archived and deleted skipped", () => {
  const map = fromJS({
    a: { last_active: { me: "2026-01-01" } },
    b: { last_active: { me: "2026-02-01" } },
    c: { state: { state: "archived" } },
    d: { deleted: true },
  });
  expect(searchableProjects(map, "me")).toEqual(["b", "a"]);
});
