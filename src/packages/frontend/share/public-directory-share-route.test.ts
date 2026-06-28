import { shareRouteCandidates } from "./public-directory-share-route";

describe("shareRouteCandidates", () => {
  it("treats a single segment as a share path first", () => {
    expect(shareRouteCandidates("test2")).toEqual([
      { slug: "test2", relativePath: "" },
    ]);
  });

  it("tries longest share path first and then peels file path segments", () => {
    expect(shareRouteCandidates("agent-test/route-1/a.ipynb")).toEqual([
      { slug: "agent-test/route-1/a.ipynb", relativePath: "" },
      { slug: "agent-test/route-1", relativePath: "a.ipynb" },
      { slug: "agent-test", relativePath: "route-1/a.ipynb" },
    ]);
  });

  it("normalizes repeated and leading slashes", () => {
    expect(shareRouteCandidates("/test2//dir/a.py")).toEqual([
      { slug: "test2/dir/a.py", relativePath: "" },
      { slug: "test2/dir", relativePath: "a.py" },
      { slug: "test2", relativePath: "dir/a.py" },
    ]);
  });

  it("keeps trying shorter slugs for direct file URLs with dotted names", () => {
    expect(shareRouteCandidates("course/unit.1/notes/a.md")).toEqual([
      { slug: "course/unit.1/notes/a.md", relativePath: "" },
      { slug: "course/unit.1/notes", relativePath: "a.md" },
      { slug: "course/unit.1", relativePath: "notes/a.md" },
      { slug: "course", relativePath: "unit.1/notes/a.md" },
    ]);
  });
});
