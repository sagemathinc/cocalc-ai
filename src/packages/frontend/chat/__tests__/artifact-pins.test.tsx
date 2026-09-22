import { act, renderHook, waitFor } from "@testing-library/react";
import { fromJS, Map } from "immutable";

let mockAccount = "account";
let mockSettings = Map<string, any>();
const mockSave = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({
      get: (key) => (key === "account_id" ? mockAccount : mockSettings),
    }),
    getActions: () => ({ set_other_settings_and_wait: mockSave }),
  },
  useTypedRedux: (_store, key) =>
    key === "account_id" ? mockAccount : mockSettings,
}));
import {
  ARTIFACT_PINS_SETTING,
  moveVisibleArtifactPin,
  normalizeArtifactPins,
  useArtifactPins,
} from "../use-artifact-pins";

beforeEach(() => {
  mockAccount = "account";
  mockSettings = Map();
  mockSave.mockReset().mockImplementation(async (key, value) => {
    mockSettings = mockSettings.set(key, value);
  });
});

test("normalizes persisted JSON and Immutable values", () => {
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
  expect(moveVisibleArtifactPin(["a"], ["a"], "a", -1)).toEqual(["a"]);
});

test("rapid writes across surfaces preserve both pins, unpinning persists after remount", async () => {
  const one = renderHook(() => useArtifactPins());
  const two = renderHook(() => useArtifactPins());
  act(() => {
    one.result.current.setPinned("room-one", true);
    two.result.current.setPinned("room-two", true);
  });
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(JSON.parse(mockSettings.get(ARTIFACT_PINS_SETTING))).toEqual([
      "room-one",
      "room-two",
    ]),
  );
  act(() => one.result.current.setPinned("room-one", false));
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(3));
  one.unmount();
  two.unmount();
  const reopened = renderHook(() => useArtifactPins());
  expect(reopened.result.current.pins).toEqual(["room-two"]);
});

test("save failure is visible and does not persist an optimistic pin", async () => {
  mockSave.mockRejectedValueOnce(Error("offline"));
  const { result } = renderHook(() => useArtifactPins());
  act(() => result.current.setPinned("a", true));
  await waitFor(() => expect(result.current.error).toMatch(/Unable to save/));
  expect(result.current.pins).toEqual([]);
});

test("queued writes are cancelled on an account switch", async () => {
  const { result, rerender } = renderHook(() => useArtifactPins());
  act(() => {
    result.current.setPinned("a", true);
    mockAccount = "other";
  });
  rerender();
  await act(async () => {});
  expect(mockSave).not.toHaveBeenCalled();
  expect(result.current.pins).toEqual([]);
});
