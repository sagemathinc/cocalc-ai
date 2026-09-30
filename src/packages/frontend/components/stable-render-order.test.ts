import { stableRenderOrder } from "./stable-render-order";

test("existing keys keep their order when the source order changes", () => {
  expect(stableRenderOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual([
    "a",
    "b",
    "c",
  ]);
});

test("new keys are appended and removed keys dropped", () => {
  expect(stableRenderOrder(["a", "b", "c"], ["d", "c", "a"])).toEqual([
    "a",
    "c",
    "d",
  ]);
  expect(stableRenderOrder([], ["b", "a"])).toEqual(["b", "a"]);
});
