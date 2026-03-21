import { flyoutTerminalOwnerPath } from "./files-terminal";

describe("flyoutTerminalOwnerPath", () => {
  it("uses the current browsing path for workspace terminal ownership", () => {
    expect(
      flyoutTerminalOwnerPath({
        browsingPath: "/repo/workspace-a",
        workspaceRoot: "/repo/workspace-a",
      }),
    ).toBe("/repo/workspace-a");
  });

  it("falls back to the workspace root when browsing path is empty", () => {
    expect(
      flyoutTerminalOwnerPath({
        browsingPath: "",
        workspaceRoot: "/repo/workspace-a",
      }),
    ).toBe("/repo/workspace-a");
  });

  it("falls back to the project root when no workspace path is available", () => {
    expect(
      flyoutTerminalOwnerPath({
        browsingPath: "",
        workspaceRoot: null,
      }),
    ).toBe("/");
  });
});
