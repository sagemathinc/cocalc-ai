import immutable from "immutable";

import { DEFAULT_ACTIVE_FILE_SORT, normalizeActiveFileSort } from "./sort";

describe("normalizeActiveFileSort", () => {
  it("accepts immutable sort state", () => {
    expect(
      normalizeActiveFileSort(
        immutable.fromJS({
          column_name: "time",
          is_descending: true,
        }),
      ),
    ).toEqual({
      column_name: "time",
      is_descending: true,
    });
  });

  it("falls back for invalid sort state", () => {
    expect(normalizeActiveFileSort({ column_name: "mtime" })).toEqual(
      DEFAULT_ACTIVE_FILE_SORT,
    );
    expect(normalizeActiveFileSort(undefined)).toEqual(
      DEFAULT_ACTIVE_FILE_SORT,
    );
  });
});
