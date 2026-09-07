import { buildLegacyFileLocations } from "./legacy-locations";
import {
  captureClassicScrollAnchor,
  classicScrollTarget,
} from "./renderer-scroll";

const files = buildLegacyFileLocations([
  { path: "a.ts", lines: ["@@ -2,2 +8,2 @@", " context", "-old", "+new"] },
]);
const anchor = {
  location: {
    targetId: "review",
    fileId: files[0].fileId,
    side: "old" as const,
    line: 3,
  },
  offset: 0,
};

test("maps a source side to the exact Classic patch row and rejects absent or ambiguous input", () => {
  expect(classicScrollTarget(files, anchor)).toMatchObject({
    fileIndex: 0,
    rowIndex: 2,
  });
  expect(
    classicScrollTarget(files, {
      ...anchor,
      location: { ...anchor.location, side: "new", line: 9 },
    }),
  ).toMatchObject({ rowIndex: 3 });
  expect(
    classicScrollTarget(files, {
      ...anchor,
      location: { ...anchor.location, line: 999 },
    }),
  ).toBeUndefined();
  expect(classicScrollTarget([...files, ...files], anchor)).toBeUndefined();
});

test("captures a visible Classic source row below the sticky header, not metadata", () => {
  const viewport = document.createElement("div");
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, height }) as DOMRect;
  viewport.getBoundingClientRect = () => rect(100, 400);
  const section = document.createElement("div");
  section.dataset.gitDiffSection = "true";
  const header = document.createElement("div");
  header.dataset.reviewFileId = "0";
  header.getBoundingClientRect = () => rect(100, 40);
  section.append(header);
  for (const [top, line] of [
    [100, 2],
    [140, undefined],
    [160, 3],
  ]) {
    const row = document.createElement("div");
    row.className = "cocalc-git-diff-line";
    if (line) row.dataset.reviewOldLine = String(line);
    row.getBoundingClientRect = () => rect(top!, 20);
    section.append(row);
  }
  viewport.append(section);
  expect(captureClassicScrollAnchor(viewport, "review", files)).toEqual({
    ...anchor,
    offset: 20,
  });
});
