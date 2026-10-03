import { act, renderHook, waitFor } from "@testing-library/react";
import { Map, fromJS } from "immutable";
import {
  normalizeCollectionPreferences,
  useCollectionPreferences,
} from "./use-collection-preferences";

let mockAccount = "alice";
let mockSettings = Map();
const mockSave = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (_store, key) =>
    key === "account_id" ? mockAccount : mockSettings,
  redux: {
    getStore: () => ({ get: () => mockAccount }),
    getActions: () => ({ set_other_settings_and_wait: mockSave }),
  },
}));
beforeEach(() => {
  mockAccount = "alice";
  mockSettings = Map();
  mockSave.mockReset().mockImplementation(async (key, value) => {
    mockSettings = mockSettings.set(key, value);
  });
});

test("normalizes serialized and immutable preferences without duplicate IDs", () => {
  expect(
    normalizeCollectionPreferences(
      fromJS({ view: "grid", order: ["a", "b", "a", 3] }),
    ),
  ).toEqual({ view: "grid", order: ["a", "b"] });
  expect(normalizeCollectionPreferences("invalid")).toEqual({
    view: "list",
    order: [],
  });
});

test("serializes rapid changes, retains hidden IDs and restores preferences on remount", async () => {
  let resolve!: () => void;
  mockSave.mockImplementationOnce(
    (key, value) =>
      new Promise<void>((done) => {
        resolve = () => {
          mockSettings = mockSettings.set(key, value);
          done();
        };
      }),
  );
  const hook = renderHook(() => useCollectionPreferences("people"));
  act(() => hook.result.current.setOrder(["hidden", "b", "a"]));
  act(() => hook.result.current.setView("grid"));
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
  await act(async () => resolve());
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2));
  expect(JSON.parse(mockSave.mock.calls[1][1])).toEqual({
    view: "grid",
    order: ["hidden", "b", "a"],
  });
  hook.unmount();
  const next = renderHook(() => useCollectionPreferences("people"));
  expect(next.result.current.value).toEqual({
    view: "grid",
    order: ["hidden", "b", "a"],
  });
});

test("failed saves remain visible with explicit retry, and account switches never expose previous pins", async () => {
  mockSave.mockRejectedValueOnce(Error("offline"));
  const hook = renderHook(() => useCollectionPreferences("people"));
  act(() => hook.result.current.setOrder(["bob"]));
  await waitFor(() => expect(hook.result.current.error).toContain("offline"));
  expect(hook.result.current.value.order).toEqual(["bob"]);
  act(() => hook.result.current.retry());
  await waitFor(() => expect(hook.result.current.error).toBeUndefined());
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2));
  mockAccount = "carol";
  mockSettings = Map();
  hook.rerender();
  expect(hook.result.current.value.order).toEqual([]);
});

test("queued writes from a previous account are discarded", async () => {
  let resolve!: () => void;
  mockSave.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const hook = renderHook(() => useCollectionPreferences("people"));
  act(() => hook.result.current.setView("grid"));
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
  act(() => hook.result.current.setOrder(["bob"]));
  mockAccount = "carol";
  hook.rerender();
  await act(async () => resolve());
  expect(mockSave).toHaveBeenCalledTimes(1);
  expect(hook.result.current.value).toEqual({ view: "list", order: [] });
  expect(hook.result.current.error).toBeUndefined();
});
