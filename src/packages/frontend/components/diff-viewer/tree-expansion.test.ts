import { readTreeExpansion, watchTreeExpansion } from "./tree-expansion";

beforeEach(() => {
  localStorage.clear();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

function fixture(scope = "account/repo/target") {
  let listener = () => {};
  let search = "";
  const expanded = new Set(["src/", "src/nested/"]);
  const model = {
    subscribe: (fn: () => void) => {
      listener = fn;
      return () => {
        listener = () => {};
      };
    },
    getSearchValue: () => search,
    getItem: (path: string) => ({
      isDirectory: () => true,
      isExpanded: () => expanded.has(path),
    }),
  };
  const persistence = watchTreeExpansion(
    model as any,
    ["src/a.ts", "src/nested/b.ts"],
    scope,
  );
  return {
    persistence,
    expanded,
    notify: () => listener(),
    search: (value: string) => {
      search = value;
      listener();
    },
  };
}

test("restores collapsed children independently of parent and target", () => {
  const f = fixture();
  f.expanded.delete("src/");
  f.notify();
  jest.advanceTimersByTime(150);
  expect(readTreeExpansion("account/repo/target")).toEqual(["src/nested/"]);
  expect(readTreeExpansion("different target")).toBeUndefined();
  f.persistence.dispose();
});

test("flush before filtering preserves the user's expansion, not search state", () => {
  const f = fixture();
  f.expanded.clear();
  f.notify();
  f.persistence.flush();
  f.search("nested");
  f.expanded.add("src/");
  jest.advanceTimersByTime(200);
  f.persistence.dispose();
  expect(readTreeExpansion("account/repo/target")).toEqual([]);
});

test("unmount flushes pending changes and unsubscribes", () => {
  const f = fixture();
  f.expanded.clear();
  f.notify();
  f.persistence.dispose();
  f.expanded.add("src/");
  f.notify();
  jest.runAllTimers();
  expect(readTreeExpansion("account/repo/target")).toEqual([]);
});

test("invalid storage and unavailable storage are harmless", () => {
  localStorage.setItem("cocalc:review-tree-expansion:v1:x", '{"paths":[]}');
  expect(readTreeExpansion("x")).toBeUndefined();
  const spy = jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw Error("quota");
    });
  expect(() => fixture().persistence.dispose()).not.toThrow();
  spy.mockRestore();
});
