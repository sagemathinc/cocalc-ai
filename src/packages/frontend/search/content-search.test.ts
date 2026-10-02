jest.mock("@cocalc/frontend/app-framework", () => ({ redux: {} }));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({}));
jest.mock("@cocalc/frontend/project/home-directory", () => ({}));

import { parseRipgrepJson } from "./content-search";

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
