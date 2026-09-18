import { Map } from "immutable";
import { nbgrader_status } from "./util";

describe("nbgrader_status", () => {
  it("treats missing assignment data as no collected work", () => {
    expect(nbgrader_status()).toEqual({
      succeeded: 0,
      failed: 0,
      not_attempted: 0,
      attempted: 0,
    });
    expect(nbgrader_status(Map())).toEqual({
      succeeded: 0,
      failed: 0,
      not_attempted: 0,
      attempted: 0,
    });
  });

  it("counts collected work as not attempted before grading", () => {
    const assignment = Map({
      last_collect: Map({ student1: Map(), student2: Map() }),
    });

    expect(nbgrader_status(assignment)).toEqual({
      succeeded: 0,
      failed: 0,
      not_attempted: 2,
      attempted: 0,
    });
  });

  it("counts successful, failed, and unattempted grading states", () => {
    const assignment = Map({
      last_collect: Map({
        student1: Map(),
        student2: Map(),
        student3: Map(),
      }),
      nbgrader_scores: Map({
        student1: Map({ score: 10 }),
        student2: Map({ error: "autograding failed" }),
      }),
    });

    expect(nbgrader_status(assignment)).toEqual({
      succeeded: 1,
      failed: 1,
      not_attempted: 1,
      attempted: 2,
    });
  });
});
