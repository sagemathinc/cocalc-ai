jest.mock("@cocalc/frontend/app-framework", () => ({ redux: {} }));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({}));
jest.mock("@cocalc/frontend/project/home-directory", () => ({}));

import {
  newestSnapshotHits,
  parseRipgrepJson,
  spreadSnapshots,
} from "./content-search";

const match = (path: string, line: number, text: string) =>
  JSON.stringify({
    type: "match",
    data: { path: { text: path }, line_number: line, lines: { text } },
  });

test("ripgrep json becomes hits relative to the home directory", () => {
  const output = [
    JSON.stringify({ type: "begin", data: {} }),
    match("/home/user/notes/a.md", 3, "  the plot spectrum\n"),
    match("/etc/other.txt", 1, "plot"),
    "not json",
  ].join("\n");
  expect(parseRipgrepJson("p", output, "/home/user")).toEqual({
    items: [
      {
        project_id: "p",
        path: "notes/a.md",
        line: 3,
        text: "the plot spectrum",
      },
      { project_id: "p", path: "/etc/other.txt", line: 1, text: "plot" },
    ],
    truncated: false,
  });
});

test("snapshot hits keep the newest snapshot of each file and line", () => {
  const dir = "/home/user/.snapshots";
  expect(
    newestSnapshotHits(
      "p",
      [
        { path: `${dir}/2026-08-01T00:00:00Z/old.md` },
        { path: `${dir}/2026-09-01T00:00:00Z/old.md` },
        { path: `${dir}/2026-08-01T00:00:00Z/a.md`, line: 2, text: "x" },
        { path: `${dir}/2026-07-01T00:00:00Z/a.md`, line: 2, text: "y" },
      ],
      dir,
    ),
  ).toEqual([
    {
      project_id: "p",
      snapshot: "2026-08-01T00:00:00Z",
      path: "a.md",
      line: 2,
      text: "x",
    },
    {
      project_id: "p",
      snapshot: "2026-09-01T00:00:00Z",
      path: "old.md",
      line: undefined,
      text: undefined,
    },
  ]);
});

test("a few snapshots spread over time are searched", () => {
  const names = [
    "2026-10-02T18:00:00Z",
    "2026-10-02T17:45:00Z",
    "2026-10-01T18:10:00Z",
    "2026-09-25T09:00:00Z",
    "2026-09-01T00:00:00Z",
    ".hidden",
  ];
  expect(spreadSnapshots(names)).toEqual([
    "2026-10-02T18:00:00Z",
    "2026-10-01T18:10:00Z",
    "2026-09-25T09:00:00Z",
    "2026-09-01T00:00:00Z",
  ]);
  expect(spreadSnapshots([])).toEqual([]);
});
