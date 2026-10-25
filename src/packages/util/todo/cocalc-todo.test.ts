import {
  parseTodo,
  todoGroups,
  todoLinkAllowed,
  todoProgress,
  TODO_LIMITS,
} from "./cocalc-todo";

const list = {
  format: "cocalc-todo",
  version: 1,
  id: "agents-polish",
  title: "Agents polish",
  updated: "2026-10-25T06:40:00Z",
  categories: { review: { label: "In review", color: "#1677ff" } },
  sections: [
    { id: "ready", title: "Ready to merge" },
    { id: "empty", title: "Nothing here" },
    { id: "next", title: "Next", description: "After the merges." },
  ],
  items: [
    { id: "b", title: "Retarget #1379", status: "todo", section: "next" },
    {
      id: "a",
      title: "Questions panel",
      status: "waiting",
      section: "ready",
      category: "review",
      priority: "high",
      waiting_for: "William's merge go",
      links: [{ label: "PR", url: "https://github.com/x/y/pull/1" }],
    },
    { id: "c", title: "Loose end", status: "done" },
    { id: "d", title: "Dropped", status: "cancelled", section: "gone" },
  ],
};

test("a valid list reads back as written", () => {
  const { ok, todo, problems } = parseTodo(JSON.stringify(list));
  expect(problems).toEqual([]);
  expect(ok).toBe(true);
  expect(todo?.title).toBe("Agents polish");
  expect(todo?.items.map((i) => i.id)).toEqual(["b", "a", "c", "d"]);
  expect(todo?.items[1]).toMatchObject({
    category: "review",
    priority: "high",
    waiting_for: "William's merge go",
  });
});

test("groups follow the sections, then items without a known section", () => {
  const { todo } = parseTodo(JSON.stringify(list));
  const groups = todoGroups(todo!);
  expect(groups.map((g) => g.section?.id)).toEqual([
    "ready",
    "next",
    undefined,
  ]);
  expect(groups[2].items.map((i) => i.id)).toEqual(["c", "d"]);
});

test("progress leaves cancelled items out", () => {
  const { todo } = parseTodo(JSON.stringify(list));
  expect(todoProgress(todo!.items)).toEqual({ done: 1, total: 3 });
});

test("bad items are named and skipped; the rest is shown", () => {
  const { ok, todo, problems } = parseTodo(
    JSON.stringify({
      ...list,
      items: [
        { id: "x", title: "Fine", status: "doing" },
        { id: "x", title: "Twice", status: "todo" },
        { id: "y", title: "", status: "todo" },
        { id: "z", title: "Odd status", status: "maybe" },
        {
          id: "w",
          title: "Bad bits",
          status: "todo",
          category: "nope",
          links: [{ label: "evil", url: "javascript:alert(1)" }],
        },
      ],
    }),
  );
  expect(ok).toBe(false);
  expect(todo?.items.map((i) => i.id)).toEqual(["x", "w"]);
  expect(todo?.items[1].category).toBeUndefined();
  expect(todo?.items[1].links).toBeUndefined();
  expect(problems.map((p) => p.path)).toEqual([
    "items[1].id",
    "items[2].title",
    "items[3].status",
    "items[4].category",
    "items[4].links[0]",
  ]);
});

test("not this format: problems and no list", () => {
  expect(parseTodo("{").todo).toBeUndefined();
  expect(parseTodo("[]").todo).toBeUndefined();
  const wrong = parseTodo(JSON.stringify({ ...list, format: "other" }));
  expect(wrong.todo).toBeUndefined();
  expect(wrong.problems[0].path).toBe("format");
  expect(
    parseTodo(JSON.stringify({ ...list, items: undefined })).todo,
  ).toBeUndefined();
});

test("too many items: the first ones are shown", () => {
  const items = Array.from({ length: TODO_LIMITS.maxItems + 5 }, (_, i) => ({
    id: `i${i}`,
    title: `Item ${i}`,
    status: "todo",
  }));
  const { todo, problems } = parseTodo(JSON.stringify({ ...list, items }));
  expect(todo?.items).toHaveLength(TODO_LIMITS.maxItems);
  expect(problems[0].path).toBe("items");
});

test("only web and mail links are allowed", () => {
  expect(todoLinkAllowed("https://cocalc.com")).toBe(true);
  expect(todoLinkAllowed("mailto:a@b.c")).toBe(true);
  expect(todoLinkAllowed("javascript:alert(1)")).toBe(false);
  expect(todoLinkAllowed("data:text/html,x")).toBe(false);
  expect(todoLinkAllowed(3)).toBe(false);
});

test("ids must be strings; a number never matches a string id", () => {
  const { todo, problems } = parseTodo(
    JSON.stringify({
      ...list,
      sections: [{ id: 1, title: "Numbered" }],
      items: [
        { id: 1, title: "Number", status: "todo" },
        { id: "1", title: "String", status: "todo", section: 1 },
      ],
    }),
  );
  expect(todo?.sections).toBeUndefined();
  expect(todo?.items.map((i) => i.id)).toEqual(["1"]);
  expect(todo?.items[0].section).toBeUndefined();
  expect(problems.map((p) => p.path)).toEqual([
    "sections[0].id",
    "items[0].id",
    "items[1].section",
  ]);
});

test("a category must be one of the list's own, not an inherited name", () => {
  const { todo, problems } = parseTodo(
    JSON.stringify({
      ...list,
      items: [
        { id: "a", title: "A", status: "todo", category: "constructor" },
        { id: "b", title: "B", status: "todo", category: "toString" },
      ],
    }),
  );
  expect(todo?.items.map((i) => i.category)).toEqual([undefined, undefined]);
  expect(problems.map((p) => p.path)).toEqual([
    "items[0].category",
    "items[1].category",
  ]);
});
