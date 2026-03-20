import { fromJS } from "immutable";

import {
  doesPersistentCellSatisfyRunCellOverlay,
  getDisplayedCellExecCount,
  getDisplayedCellOutput,
} from "../run-cell-overlay";

describe("jupyter run cell overlay helpers", () => {
  it("prefers overlay output and exec_count while a run is in flight", () => {
    const cell = fromJS({
      id: "c1",
      exec_count: 7,
      output: {
        0: { text: "old" },
      },
    });
    const overlay = fromJS({
      exec_count: 8,
      output: {
        0: { text: "new", exec_count: 8 },
      },
    });

    expect(getDisplayedCellOutput(cell, overlay)?.getIn(["0", "text"])).toBe(
      "new",
    );
    expect(getDisplayedCellExecCount(cell, overlay)).toBe(8);
  });

  it("does not clear the prompt when only output is being replaced", () => {
    const cell = fromJS({
      id: "c1",
      exec_count: 12,
      output: {
        0: { text: "old" },
      },
    });
    const overlay = fromJS({
      output: {
        0: { text: "streaming" },
      },
    });

    expect(getDisplayedCellExecCount(cell, overlay)).toBe(12);
  });

  it("clears the local overlay once durable cell state catches up", () => {
    const overlay = fromJS({
      exec_count: 9,
      output: {
        0: { text: "done", exec_count: 9 },
      },
    });
    const before = fromJS({
      id: "c1",
      exec_count: 8,
      output: {
        0: { text: "old", exec_count: 8 },
      },
    });
    const after = fromJS({
      id: "c1",
      exec_count: 9,
      output: {
        0: { text: "done", exec_count: 9 },
      },
    });

    expect(doesPersistentCellSatisfyRunCellOverlay(before, overlay)).toBe(
      false,
    );
    expect(doesPersistentCellSatisfyRunCellOverlay(after, overlay)).toBe(true);
  });
});
