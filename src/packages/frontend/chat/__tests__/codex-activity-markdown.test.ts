import { codexEventsToMarkdown, parsePathLineTarget } from "../codex-activity";

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

  it("hides byte-size unless backend marks bytes as exact", () => {
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
    expect(markdown).toContain("- File: Read `README.md`");
    expect(markdown).not.toContain("2.0 KB");
  });

  it("keeps byte-size for explicit read events with exact marker", () => {
    const markdown = codexEventsToMarkdown([
      {
        type: "event",
        seq: 1,
        event: {
          type: "file",
          path: "README.md",
          operation: "read",
          bytes: 2048,
          bytes_known: true,
        },
      } as any,
    ]);
    expect(markdown).toContain("- File: Read `README.md` (2.0 KB)");
  });

  it("hides byte-size for command-derived write events", () => {
    const markdown = codexEventsToMarkdown([
      {
        type: "event",
        seq: 1,
        event: {
          type: "file",
          path: "src/workspaces.py",
          operation: "write",
          bytes: 8192,
          command: "cat > src/workspaces.py <<'EOF' ...",
        },
      } as any,
    ]);
    expect(markdown).toContain("- File: Wrote `src/workspaces.py`");
    expect(markdown).not.toContain("8.0 KB");
    expect(markdown).not.toContain("KB");
    expect(markdown).not.toContain("byte");
  });

  it("keeps byte-size for explicit write events with exact marker", () => {
    const markdown = codexEventsToMarkdown([
      {
        type: "event",
        seq: 1,
        event: {
          type: "file",
          path: "README.md",
          operation: "write",
          bytes: 2048,
          bytes_known: true,
        },
      } as any,
    ]);
    expect(markdown).toContain("- File: Wrote `README.md` (2.0 KB)");
  });
});

describe("parsePathLineTarget", () => {
  it("extracts :line suffix from activity file paths", () => {
    expect(
      parsePathLineTarget(
        "/Users/williamstein/build/cocalc-lite/src/packages/plus/reflect/manager.ts:485",
      ),
    ).toEqual({
      path: "/Users/williamstein/build/cocalc-lite/src/packages/plus/reflect/manager.ts",
      line: 485,
    });
  });

  it("extracts #L anchors from activity file paths", () => {
    expect(parsePathLineTarget("/tmp/workspaces.py#L42")).toEqual({
      path: "/tmp/workspaces.py",
      line: 42,
    });
  });

  it("prefers explicit line metadata when available", () => {
    expect(parsePathLineTarget("/tmp/workspaces.py:42", 7)).toEqual({
      path: "/tmp/workspaces.py",
      line: 7,
    });
  });
});
