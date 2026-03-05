import {
  parseDarwinCwdFromLsofOutput,
  toHomeRelativePath,
} from "./cwd";

describe("terminal cwd helpers", () => {
  test("parseDarwinCwdFromLsofOutput extracts cwd path from lsof output", () => {
    const stdout = [
      "p4242",
      "fcwd",
      "n/Users/alice/work/project",
      "f1",
      "n/dev/null",
      "",
    ].join("\n");
    expect(parseDarwinCwdFromLsofOutput(stdout)).toBe(
      "/Users/alice/work/project",
    );
  });

  test("parseDarwinCwdFromLsofOutput supports CRLF", () => {
    const stdout = "p9\r\nfcwd\r\nn/Users/bob/Library/Application Support/cocalc\r\n";
    expect(parseDarwinCwdFromLsofOutput(stdout)).toBe(
      "/Users/bob/Library/Application Support/cocalc",
    );
  });

  test("parseDarwinCwdFromLsofOutput returns undefined when no path line exists", () => {
    const stdout = ["p7", "fcwd", "f1", "n/dev/null", ""].join("\n");
    expect(parseDarwinCwdFromLsofOutput(stdout)).toBeUndefined();
  });

  test("toHomeRelativePath returns a relative path under HOME", () => {
    expect(
      toHomeRelativePath("/Users/alice/work/project", "/Users/alice"),
    ).toBe("work/project");
  });

  test("toHomeRelativePath leaves non-home paths absolute", () => {
    expect(toHomeRelativePath("/tmp", "/Users/alice")).toBe("/tmp");
  });
});

