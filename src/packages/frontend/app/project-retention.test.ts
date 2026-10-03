import {
  noteProjectVisit,
  projectsToRelease,
  resetProjectVisitsForTests,
} from "./project-retention";

beforeEach(resetProjectVisitsForTests);

test("nothing is released within the limit", () => {
  expect(projectsToRelease(["a", "b"], "a", 3)).toEqual([]);
});

test("the least recently visited are released, never the current one", () => {
  for (const id of ["a", "b", "c", "d"]) noteProjectVisit(id);
  noteProjectVisit("a"); // a is now the most recent
  expect(projectsToRelease(["a", "b", "c", "d"], "d", 2)).toEqual(["b", "c"]);
  expect(projectsToRelease(["a", "b", "c", "d"], "b", 3)).toEqual(["c"]);
});

test("projects not visited this session go first, in open order", () => {
  noteProjectVisit("c");
  expect(projectsToRelease(["x", "y", "c", "z"], "z", 2)).toEqual(["x", "y"]);
});
