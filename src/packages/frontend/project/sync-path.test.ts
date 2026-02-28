import { termPath } from "@cocalc/util/terminal/names";
import { canonicalSyncPath, toAbsoluteProjectPath } from "./sync-path";

describe("toAbsoluteProjectPath", () => {
  const HOME = "/home/wstein/work";

  it("normalizes relative paths against the provided home", () => {
    expect(toAbsoluteProjectPath("src/main.ts", HOME)).toBe(
      "/home/wstein/work/src/main.ts",
    );
  });

  it("normalizes explicit absolute paths unchanged", () => {
    expect(toAbsoluteProjectPath("/tmp/../tmp/test.txt", HOME)).toBe("/tmp/test.txt");
  });

  it("expands ~ and ~/ to the provided home", () => {
    expect(toAbsoluteProjectPath("~", HOME)).toBe(HOME);
    expect(toAbsoluteProjectPath("~/docs/readme.md", HOME)).toBe(
      "/home/wstein/work/docs/readme.md",
    );
  });
});

describe("canonicalSyncPath", () => {
  const HOME = "/home/wstein/work";

  it("always returns an absolute path for regular files", () => {
    expect(canonicalSyncPath("notes/todo.md", HOME)).toBe(
      "/home/wstein/work/notes/todo.md",
    );
  });

  it("maps non-hidden terminals to the canonical numbered terminal identity", () => {
    expect(canonicalSyncPath("shell.term", HOME)).toBe(
      termPath({ path: "/home/wstein/work/shell.term", cmd: "", number: 0 }),
    );
  });

  it("keeps hidden terminal paths absolute without remapping", () => {
    expect(canonicalSyncPath(".shell.term", HOME)).toBe("/home/wstein/work/.shell.term");
  });
});
