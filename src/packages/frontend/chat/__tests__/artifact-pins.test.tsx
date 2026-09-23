import { act, renderHook } from "@testing-library/react";
import { fromJS } from "immutable";

const setPinned = jest.fn();
const movePinned = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "account",
}));
jest.mock("@cocalc/frontend/agents/personal-library", () => ({
  usePersonalLibrary: () => ({
    pins: ["one", "two"],
    error: "",
    setPinned,
    movePinned,
  }),
}));

import {
  moveVisibleArtifactPin,
  normalizeArtifactPins,
  useArtifactPins,
} from "../use-artifact-pins";

test("normalizes legacy JSON and Immutable values", () => {
  expect(normalizeArtifactPins('["a","a","b"]')).toEqual(["a", "b"]);
  expect(normalizeArtifactPins(fromJS(["a", "b"]))).toEqual(["a", "b"]);
  expect(normalizeArtifactPins("broken")).toEqual([]);
});

test("filtered reordering preserves hidden pins", () => {
  expect(
    moveVisibleArtifactPin(
      ["a", "hidden", "b", "other-room"],
      ["a", "b"],
      "b",
      0,
    ),
  ).toEqual(["b", "hidden", "a", "other-room"]);
});

test("pin actions use personal-library API", () => {
  setPinned.mockResolvedValue(undefined);
  movePinned.mockResolvedValue(undefined);
  const { result } = renderHook(() => useArtifactPins());
  act(() => {
    result.current.setPinned("one", false);
    result.current.move(["one", "two"], "two", 0);
  });
  expect(result.current.pins).toEqual(["one", "two"]);
  expect(setPinned).toHaveBeenCalledWith("one", false);
  expect(movePinned).toHaveBeenCalledWith(["one", "two"], "two", 0);
});
