import { act, renderHook } from "@testing-library/react";
import { useHistoryLoad } from "./use-history-load";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("hides an old document immediately and ignores out-of-order source loads", async () => {
  const first = deferred<string>(),
    second = deferred<string>(),
    third = deferred<string>();
  const { result, rerender } = renderHook(
    ({ selection, load }) => useHistoryLoad(selection, load),
    { initialProps: { selection: {}, load: () => first.promise } },
  );
  await act(async () => first.resolve("Git version"));
  expect(result.current?.value).toBe("Git version");
  rerender({ selection: {}, load: () => second.promise });
  expect(result.current).toBeUndefined();
  rerender({ selection: {}, load: () => third.promise });
  await act(async () => third.resolve("Backup version"));
  await act(async () => second.resolve("Stale snapshot version"));
  expect(result.current?.value).toBe("Backup version");
});

test("a missing or failed version never retains restorable content", async () => {
  const first = deferred<string | undefined>(),
    second = deferred<string | undefined>();
  const { result, rerender } = renderHook(
    ({ selection, load }) => useHistoryLoad(selection, load),
    { initialProps: { selection: {}, load: () => first.promise } },
  );
  await act(async () => first.resolve("Previous source"));
  rerender({ selection: {}, load: () => second.promise });
  await act(async () => second.reject(Error("Version unavailable")));
  expect(result.current?.value).toBeUndefined();
  expect(result.current?.error).toContain("Version unavailable");
  rerender({ selection: {}, load: () => Promise.resolve(undefined) });
  await act(async () => {});
  expect(result.current?.value).toBeUndefined();
  expect(result.current?.error).toBeUndefined();
});
