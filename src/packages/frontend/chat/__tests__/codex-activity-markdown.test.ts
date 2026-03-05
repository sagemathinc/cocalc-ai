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

  it("hides byte-size for command-derived read events", () => {
    const markdown = codexEventsToMarkdown([
      {
        type: "event",
        seq: 1,
        event: {
          type: "file",
          path: "src/workspaces.py",
          operation: "read",
          bytes: 1572864,
          line: 1,
          limit: 20,
          command: "sed -n '1,20p' src/workspaces.py",
        },
      } as any,
    ]);
    expect(markdown).toContain(
      "- File: Read `src/workspaces.py#L1` (20 lines)",
    );
    expect(markdown).not.toContain("MB");
    expect(markdown).not.toContain("KB");
    expect(markdown).not.toContain("byte");
  });

  it("keeps byte-size for explicit read events without command context", () => {
    const markdown = codexEventsToMarkdown([
      {
        type: "event",
        seq: 1,
        event: {
          type: "file",
          path: "README.md",
          operation: "read",
          bytes: 2048,
        },
      } as any,
    ]);
    expect(markdown).toContain("- File: Read `README.md` (2.0 KB)");
  });
});
