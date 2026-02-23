import { codexEventsToMarkdown } from "../codex-activity";

describe("codexEventsToMarkdown", () => {
  it("formats file paths as inline code (not markdown links)", () => {
    const markdown = codexEventsToMarkdown([
      {
        type: "event",
        seq: 1,
        event: {
          type: "file",
          path: "src/workspaces.py",
          operation: "read",
          line: 42,
        },
      } as any,
    ]);

    expect(markdown).toContain("- File: Read `src/workspaces.py#L42`");
    expect(markdown).not.toContain("](");
  });
});

