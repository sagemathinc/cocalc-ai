import { projectFileTargetFromHref } from "../project-file-target";

describe("projectFileTargetFromHref", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";

  it("resolves sandbox and relative file references", () => {
    expect(
      projectFileTargetFromHref({
        href: "sandbox:/home/user/report.pdf#L12",
        projectId,
        basePath: "/home/user/work",
      }),
    ).toEqual({ path: "/home/user/report.pdf", line: 12 });
    expect(
      projectFileTargetFromHref({
        href: "src/index.ts:7",
        projectId,
        basePath: "/home/user/work",
      }),
    ).toEqual({ path: "/home/user/work/src/index.ts", line: 7 });
  });

  it("parses internal file URLs and rejects external URLs", () => {
    expect(
      projectFileTargetFromHref({
        href: "cocalc-file://open?path=%2Ftmp%2Fnotes.md&line=4",
        projectId,
      }),
    ).toEqual({ path: "/tmp/notes.md", line: 4 });
    expect(
      projectFileTargetFromHref({
        href: "https://example.com/report.pdf",
        projectId,
      }),
    ).toBeUndefined();
  });
});
