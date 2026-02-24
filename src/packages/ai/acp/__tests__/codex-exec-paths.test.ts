import { CodexExecAgent } from "../codex-exec";

describe("CodexExecAgent event path formatting", () => {
  const agent = new CodexExecAgent();
  const toEventPath = (pathAbs: string, cwd: string) =>
    (agent as any).toHomeRelative(pathAbs, cwd);

  it("uses cwd-relative paths for files under cwd", () => {
    const cwd = "/home/test/project/src";
    const pathAbs = "/home/test/project/src/packages/backend/sandbox/rustic.ts";
    expect(toEventPath(pathAbs, cwd)).toBe(
      "packages/backend/sandbox/rustic.ts",
    );
  });

  it("keeps absolute paths for files outside cwd", () => {
    const cwd = "/home/test/project/src";
    const pathAbs = "/home/test/project/README.md";
    expect(toEventPath(pathAbs, cwd)).toBe(pathAbs);
  });
});

