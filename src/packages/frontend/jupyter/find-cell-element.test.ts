import { findCellElement } from "./find-cell-element";

describe("findCellElement", () => {
  it.each([
    "2ff452\\",
    'id["quoted"]',
    "9903f2-heading?",
    "1:with.dots",
    "heading\nnext",
  ])("matches %s literally within the requested frame", (id) => {
    const otherFrame = document.createElement("div");
    const frame = document.createElement("div");
    const other = document.createElement("div");
    const cell = document.createElement("div");
    other.id = cell.id = id;
    otherFrame.appendChild(other);
    frame.appendChild(cell);
    document.body.append(otherFrame, frame);
    try {
      expect(findCellElement(frame, id)).toBe(cell);
      expect(findCellElement(otherFrame, id)).toBe(other);
      expect(findCellElement(frame, "missing")).toBeUndefined();
    } finally {
      otherFrame.remove();
      frame.remove();
    }
  });

  it("handles an unmounted frame or absent current cell", () => {
    expect(findCellElement(null, "cell")).toBeUndefined();
    expect(
      findCellElement(document.createElement("div"), undefined),
    ).toBeUndefined();
  });
});
