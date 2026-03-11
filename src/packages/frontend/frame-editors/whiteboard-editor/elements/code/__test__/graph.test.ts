import {
  getCodeTreeOrder,
  getDirectCodeChildren,
  getNextCodeTreeSuccessor,
  getPreviousCodeTreePredecessor,
} from "../graph";

function code(id: string, x: number, y: number, page = "page1"): any {
  return { id, type: "code", x, y, page, w: 10, h: 10, z: 0, data: {} };
}

function edge(from: string, to: string, id = `${from}-${to}`): any {
  return { id, type: "edge", x: 0, y: 0, w: 0, h: 0, z: 0, data: { from, to } };
}

describe("whiteboard code graph helpers", () => {
  it("orders direct children by x, then y, then id", () => {
    const elements = {
      root: code("root", 0, 0),
      low: code("low", 50, 100),
      upperRight: code("upperRight", 100, 20),
      upperLeftA: code("upperLeftA", 10, 20),
      upperLeftB: code("upperLeftB", 10, 20),
      e1: edge("root", "low"),
      e2: edge("root", "upperRight"),
      e3: edge("root", "upperLeftB"),
      e4: edge("root", "upperLeftA"),
    };

    expect(getDirectCodeChildren(elements, "root", ["page1"])).toEqual([
      "upperLeftA",
      "upperLeftB",
      "low",
      "upperRight",
    ]);
  });

  it("computes preorder successors within a rooted tree", () => {
    const elements = {
      root: code("root", 0, 0),
      left: code("left", 0, 20),
      right: code("right", 100, 30),
      leftLeaf: code("leftLeaf", 0, 40),
      e1: edge("root", "left"),
      e2: edge("root", "right"),
      e3: edge("left", "leftLeaf"),
    };

    expect(getCodeTreeOrder(elements, "root", ["page1"])).toEqual({
      order: ["root", "left", "leftLeaf", "right"],
    });
    expect(getNextCodeTreeSuccessor(elements, "root", ["page1"])).toBe("left");
    expect(getNextCodeTreeSuccessor(elements, "left", ["page1"])).toBe(
      "leftLeaf",
    );
    expect(getNextCodeTreeSuccessor(elements, "leftLeaf", ["page1"])).toBe(
      "right",
    );
    expect(getNextCodeTreeSuccessor(elements, "right", ["page1"])).toBe(
      undefined,
    );
    expect(getPreviousCodeTreePredecessor(elements, "root", ["page1"])).toBe(
      undefined,
    );
    expect(getPreviousCodeTreePredecessor(elements, "left", ["page1"])).toBe(
      "root",
    );
    expect(
      getPreviousCodeTreePredecessor(elements, "leftLeaf", ["page1"]),
    ).toBe("left");
    expect(getPreviousCodeTreePredecessor(elements, "right", ["page1"])).toBe(
      "leftLeaf",
    );
  });

  it("rejects reachable cycles for run tree", () => {
    const elements = {
      a: code("a", 0, 0),
      b: code("b", 0, 10),
      e1: edge("a", "b"),
      e2: edge("b", "a"),
    };

    expect(getCodeTreeOrder(elements, "a", ["page1"])).toEqual({
      error: "Run Tree requires the reachable code-cell graph to be acyclic.",
    });
  });

  it("rejects multiple incoming code edges in the reachable subtree", () => {
    const elements = {
      root: code("root", 0, 0),
      left: code("left", 0, 10),
      right: code("right", 10, 10),
      shared: code("shared", 5, 20),
      e1: edge("root", "left"),
      e2: edge("root", "right"),
      e3: edge("left", "shared"),
      e4: edge("right", "shared"),
    };

    expect(getCodeTreeOrder(elements, "root", ["page1"])).toEqual({
      error:
        "Run Tree requires every reachable code cell after the root to have exactly one incoming code edge.",
    });
  });
});
