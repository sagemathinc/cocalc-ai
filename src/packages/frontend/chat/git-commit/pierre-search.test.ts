import { buildLegacyFileLocations } from "./legacy-locations";
import { highlightPierreSearch, pierreSearchLines } from "./pierre-search";

test("maps context matches to both sides and excludes metadata", () => {
  const files = buildLegacyFileLocations([
    { path: "a.ts", lines: ["@@ -2,2 +8,2 @@", " context", "-old", "+new"] },
  ]);
  const matches = pierreSearchLines(
    files,
    new Map([[0, new Set([0, 1, 2, 3])]]),
  );
  expect(matches.get(files[0].fileId)).toEqual(
    new Set(["old:2", "new:8", "old:3", "new:9"]),
  );
});

test("highlights matching rows without changing text and clears recycled rows", () => {
  const host = document.createElement("diffs-container");
  const root = host.attachShadow({ mode: "open" });
  const row = document.createElement("div");
  row.dataset.line = "4";
  row.dataset.lineType = "change-deletion";
  row.textContent = "literal + text";
  root.append(row);
  highlightPierreSearch(host, new Set(["old:4"]));
  expect(row).toHaveAttribute("data-cocalc-find-match");
  expect(row.textContent).toBe("literal + text");
  row.dataset.lineType = "change-addition";
  highlightPierreSearch(host, new Set(["old:4"]));
  expect(row).not.toHaveAttribute("data-cocalc-find-match");
  highlightPierreSearch(host, new Set(["new:4"]));
  expect(row).toHaveAttribute("data-cocalc-find-match");
  highlightPierreSearch(host);
  expect(row).not.toHaveAttribute("data-cocalc-find-match");
});
