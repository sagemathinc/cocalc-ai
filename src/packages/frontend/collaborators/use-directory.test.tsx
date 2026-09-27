import { act, renderHook, waitFor } from "@testing-library/react";
import { useDirectory } from "./use-directory";
import type { CollaborationPage } from "@cocalc/util/collaborators";
import { DirectoryRevisionContext } from "./use-directory-revision";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const page = (name: string, next?: string): CollaborationPage<string> => ({
  items: [name],
  coverage: "complete",
  next,
});

test("late responses cannot cross an account/filter key, including A-B-A navigation", async () => {
  const first = deferred<CollaborationPage<string>>();
  const second = deferred<CollaborationPage<string>>();
  const third = deferred<CollaborationPage<string>>();
  const load = jest
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  const { result, rerender } = renderHook(
    ({ key }) => useDirectory(key, load),
    { initialProps: { key: "account-a:query" } },
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  rerender({ key: "account-b:query" });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await act(async () => first.resolve(page("private-a")));
  expect(result.current.page).toBeUndefined();
  rerender({ key: "account-a:query" });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  await act(async () => second.resolve(page("private-b")));
  expect(result.current.page).toBeUndefined();
  await act(async () => third.resolve(page("fresh-a")));
  expect(result.current.page?.items).toEqual(["fresh-a"]);
});

test("pagination replaces a bounded page and binds cursors to the filters", async () => {
  const load = jest.fn(async (cursor?: string) =>
    cursor ? page("second") : page("first", "next-1"),
  );
  const { result, rerender } = renderHook(
    ({ key }) => useDirectory(key, load),
    { initialProps: { key: "all" } },
  );
  await waitFor(() => expect(result.current.page?.items).toEqual(["first"]));
  act(() => result.current.next());
  await waitFor(() => expect(result.current.page?.items).toEqual(["second"]));
  expect(load).toHaveBeenLastCalledWith("next-1", expect.any(AbortSignal));
  expect(result.current.pageNumber).toBe(2);
  rerender({ key: "project-filter" });
  expect(result.current.page).toBeUndefined();
  await waitFor(() => expect(result.current.page?.items).toEqual(["first"]));
  expect(load).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal));
  expect(result.current.pageNumber).toBe(1);
});

test("inactive mounts hide cached metadata and revalidate before showing it again", async () => {
  const load = jest.fn().mockResolvedValueOnce(page("old"));
  const { result, rerender } = renderHook(
    ({ active }) => useDirectory("account", load, active),
    { initialProps: { active: true } },
  );
  await waitFor(() => expect(result.current.page?.items).toEqual(["old"]));
  rerender({ active: false });
  expect(result.current.page).toBeUndefined();
  load.mockRejectedValueOnce(Error("access removed"));
  rerender({ active: true });
  expect(result.current.page).toBeUndefined();
  await waitFor(() => expect(result.current.error).toContain("access removed"));
  expect(result.current.page).toBeUndefined();
});

test("selected content revalidation preserves the runtime until a definitive access failure", async () => {
  let generation = 1;
  const fresh = deferred<CollaborationPage<string>>();
  const load = jest
    .fn()
    .mockResolvedValueOnce(page("authorized"))
    .mockReturnValueOnce(fresh.promise);
  const { result, rerender } = renderHook(
    () => useDirectory("selected-resource", load, true, true),
    {
      wrapper: ({ children }) => (
        <DirectoryRevisionContext.Provider value={{ generation, ready: true }}>
          {children}
        </DirectoryRevisionContext.Provider>
      ),
    },
  );
  await waitFor(() =>
    expect(result.current.page?.items).toEqual(["authorized"]),
  );
  generation = 2;
  rerender();
  expect(result.current.loading).toBe(true);
  expect(result.current.page?.items).toEqual(["authorized"]);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await act(async () => fresh.reject(Error("access removed")));
  expect(result.current.page).toBeUndefined();
  expect(result.current.error).toContain("access removed");
});
