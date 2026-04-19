import { getProjectInitCommand } from "./startup";

describe("terminal startup init command", () => {
  it("keeps the screen reset when no terminal init file exists", () => {
    expect(
      getProjectInitCommand({
        hasTerminalInitFile: false,
      }),
    ).toContain("reset;");
  });

  it("preserves terminal init file output when a terminal init file exists", () => {
    const command = getProjectInitCommand({
      hasTerminalInitFile: true,
    });
    expect(command).toContain("history -d $(history 1);");
    expect(command).not.toContain("reset;");
  });
});
