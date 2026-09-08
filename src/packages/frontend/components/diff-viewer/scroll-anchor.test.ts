import {
  capturePierreScrollAnchor,
  readScrollAnchor,
  writeScrollAnchor,
} from "./scroll-anchor";

function rect(top: number, height: number) {
  return { top, bottom: top + height, height } as DOMRect;
}
test("captures visible deletion lines in shadow DOM, excluding obscured rows", () => {
  const viewport = document.createElement("div");
  viewport.getBoundingClientRect = () => rect(100, 400);
  const host = document.createElement("diffs-container");
  const header = document.createElement("div");
  header.dataset.reviewFileId = "file";
  host.append(header);
  viewport.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  for (const [line, top] of [
    [1, 100],
    [2, 140],
    [3, 170],
  ]) {
    const row = document.createElement("div");
    row.dataset.line = String(line);
    row.dataset.lineType = "change-deletion";
    row.getBoundingClientRect = () => rect(top, 30);
    shadow.append(row);
  }
  expect(capturePierreScrollAnchor(viewport, "scope", 50)).toEqual({
    location: { targetId: "scope", fileId: "file", side: "old", line: 2 },
    offset: -10,
  });
});

test("persisted anchors are scoped and malformed storage is ignored", () => {
  localStorage.clear();
  const anchor = {
    location: {
      targetId: "one",
      fileId: "file",
      side: "new" as const,
      line: 23,
    },
    offset: 2,
  };
  writeScrollAnchor(anchor);
  expect(readScrollAnchor("one")).toEqual(anchor);
  expect(readScrollAnchor("two")).toBeUndefined();
  localStorage.setItem("cocalc:review-scroll:v1:two", JSON.stringify(anchor));
  expect(readScrollAnchor("two")).toBeUndefined();
  localStorage.setItem(
    "cocalc:review-scroll:v1:one",
    JSON.stringify({ ...anchor, offset: 1e20 }),
  );
  expect(readScrollAnchor("one")).toBeUndefined();
});
