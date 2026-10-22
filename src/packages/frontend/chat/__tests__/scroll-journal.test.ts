import {
  clearScrollJournal,
  journalScroll,
  journalScrollWrites,
  scrollJournal,
} from "../scroll-journal";

beforeEach(() => clearScrollJournal());

test("entries are kept in order, with their data", () => {
  journalScroll("input");
  journalScroll("scroll", { top: 10 });
  expect(scrollJournal().map((e) => [e.kind, e.top])).toEqual([
    ["input", undefined],
    ["scroll", 10],
  ]);
});

test("every scroll position written to the element is recorded, and still applied", () => {
  const element = document.createElement("div");
  const scrollTo = jest.fn();
  element.scrollTo = scrollTo as any;
  const undo = journalScrollWrites(element);
  element.scrollTop = 120;
  element.scrollTo({ top: 300 });
  expect(scrollTo).toHaveBeenCalledWith({ top: 300 });
  expect(scrollJournal().map(({ kind, via, to }) => [kind, via, to])).toEqual([
    ["write", "scrollTop", 120],
    ["write", "scrollTo", 300],
  ]);
  undo();
  element.scrollTop = 5;
  expect(scrollJournal()).toHaveLength(2);
});

test("it keeps the newest entries only", () => {
  for (let i = 0; i < 3100; i++) journalScroll("scroll", { top: i });
  const all = scrollJournal();
  expect(all).toHaveLength(3000);
  expect(all[all.length - 1].top).toBe(3099);
});

test("an element with its own fixed scrollTop is left alone", () => {
  const element = document.createElement("div");
  Object.defineProperty(element, "scrollTop", { value: 7, writable: true });
  expect(() => journalScrollWrites(element)()).not.toThrow();
  expect(element.scrollTop).toBe(7);
});

test("an entry's kind is never replaced by its data", () => {
  journalScroll("jump", { kind: "search-jump", reason: "search-jump" });
  expect(scrollJournal()[0]).toMatchObject({
    kind: "jump",
    reason: "search-jump",
  });
});
