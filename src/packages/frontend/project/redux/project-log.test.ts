import type { ProjectLogRow } from "@cocalc/conat/hub/api/projects";
import {
  buildProjectLogRowsFromStream,
  filterProjectLogRows,
  normalizeProjectLogTime,
  pageProjectLogRows,
} from "./project-log";

function row(id: string, time: string): ProjectLogRow {
  return {
    id,
    project_id: "project-1",
    account_id: "account-1",
    time: new Date(time),
    event: { action: id },
  };
}

describe("project log helpers", () => {
  it("normalizes valid project log times and rejects invalid values", () => {
    expect(
      normalizeProjectLogTime("2026-05-08T12:00:00.000Z")?.toISOString(),
    ).toBe("2026-05-08T12:00:00.000Z");
    expect(normalizeProjectLogTime("not a date")).toBeNull();
    expect(normalizeProjectLogTime(null)).toBeNull();
  });

  it("builds sorted unique rows from a project log stream", () => {
    const stream = {
      getAll: () => [
        row("a", "2026-05-08T12:00:00.000Z"),
        row("b", "2026-05-08T12:02:00.000Z"),
        row("a", "2026-05-08T12:01:00.000Z"),
        {
          id: "missing-account",
          project_id: "project-1",
          account_id: "",
          time: new Date("2026-05-08T12:03:00.000Z"),
          event: {},
        },
      ],
      time: () => undefined,
    };

    expect(
      buildProjectLogRowsFromStream(stream as any, "fallback-project").map(
        ({ id }) => id,
      ),
    ).toEqual(["b", "a"]);
  });

  it("uses stream timestamps when rows do not have valid times", () => {
    const stream = {
      getAll: () => [
        {
          id: "a",
          project_id: undefined,
          account_id: "account-1",
          time: "invalid",
          event: {},
        },
      ],
      time: () => new Date("2026-05-08T12:04:00.000Z"),
    };

    expect(buildProjectLogRowsFromStream(stream as any, "project-1")).toEqual([
      expect.objectContaining({
        id: "a",
        project_id: "project-1",
        time: new Date("2026-05-08T12:04:00.000Z"),
      }),
    ]);
  });

  it("filters rows relative to newer and older cursors", () => {
    const rows = [
      row("c", "2026-05-08T12:02:00.000Z"),
      row("b", "2026-05-08T12:01:00.000Z"),
      row("a", "2026-05-08T12:00:00.000Z"),
    ];

    expect(
      filterProjectLogRows(rows, {
        newer_than: { id: "b", time: new Date("2026-05-08T12:01:00.000Z") },
      }).map(({ id }) => id),
    ).toEqual(["c"]);

    expect(
      filterProjectLogRows(rows, {
        older_than: { id: "b", time: new Date("2026-05-08T12:01:00.000Z") },
      }).map(({ id }) => id),
    ).toEqual(["a"]);
  });

  it("pages filtered rows and reports when more rows are available", () => {
    const rows = [
      row("c", "2026-05-08T12:02:00.000Z"),
      row("b", "2026-05-08T12:01:00.000Z"),
      row("a", "2026-05-08T12:00:00.000Z"),
    ];

    expect(pageProjectLogRows(rows, { limit: 2 })).toEqual({
      entries: rows.slice(0, 2),
      has_more: true,
    });
  });
});
