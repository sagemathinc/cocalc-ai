import {
  CONCURRENCY,
  fdGlob,
  fdOptions,
  runProjectFileSearch,
} from "./file-search-runner";

jest.mock("@cocalc/frontend/app-framework", () => ({ redux: {} }));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: async () => {},
}));
jest.mock("@cocalc/frontend/project/home-directory", () => ({
  resolveProjectHomeDirectory: async () => "/home/user",
}));

const options = { hidden: false, caseSensitive: false, ignore: true };

test("searches recent projects first, a few at a time; unresponsive ones are unavailable", async () => {
  const projects = Array.from({ length: 10 }, (_, i) => `p${i}`);
  let running = 0;
  let maxRunning = 0;
  const started: string[] = [];
  const search = jest.fn(async (project_id: string) => {
    started.push(project_id);
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 1));
    running--;
    if (project_id === "p3") throw Error("host offline");
    return {
      paths: project_id === "p1" ? ["notes/a.md", "a.md"] : [],
      truncated: false,
    };
  });
  const reports: number[] = [];
  const result = await runProjectFileSearch({
    project_ids: projects,
    query: "a.md",
    options,
    search,
    report: (p) => reports.push(p.searched.length),
  });
  expect(started.slice(0, CONCURRENCY)).toEqual(projects.slice(0, CONCURRENCY));
  expect(maxRunning).toBeLessThanOrEqual(CONCURRENCY);
  expect(result.hits).toEqual([
    { project_id: "p1", path: "notes/a.md" },
    { project_id: "p1", path: "a.md" },
  ]);
  expect(result.unavailable).toEqual(["p3"]);
  expect(result.searched).toHaveLength(9);
  expect(result.pending).toEqual([]);
  expect(reports.length).toBe(10);
});

test("the time budget leaves the rest for Search more", async () => {
  let t = 0;
  const result = await runProjectFileSearch({
    project_ids: ["a", "b", "c", "d", "e", "f", "g", "h"],
    query: "x",
    options,
    budgetMs: 100,
    now: () => t,
    search: async () => {
      t += 60; // each project takes 60 "ms"
      return { paths: [], truncated: false };
    },
    report: () => {},
  });
  expect(result.searched.length).toBeLessThan(8);
  expect(result.pending.length).toBe(8 - result.searched.length);
});

test("canceling stops further work", async () => {
  let canceled = false;
  const result = await runProjectFileSearch({
    project_ids: Array.from({ length: 20 }, (_, i) => `p${i}`),
    query: "x",
    options,
    canceled: () => canceled,
    search: async () => {
      canceled = true;
      return { paths: ["x"], truncated: false };
    },
    report: () => {},
  });
  expect(result.searched).toEqual([]);
});

test("fd options mirror the project search toggles", () => {
  expect(fdGlob("thesis")).toBe("*thesis*");
  expect(fdGlob("*.ipynb")).toBe("*.ipynb");
  expect(fdOptions(options)).toEqual(["-g", "-i", "--max-results", "50"]);
  expect(
    fdOptions({ hidden: true, caseSensitive: true, ignore: false }),
  ).toEqual(["-g", "-H", "-I", "-s", "--max-results", "50"]);
});
