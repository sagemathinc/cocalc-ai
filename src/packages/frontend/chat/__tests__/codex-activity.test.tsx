import React from "react";
import { render, screen } from "@testing-library/react";
import CodexActivity, { TerminalRow } from "../codex-activity";

jest.mock("@cocalc/frontend/components", () => {
  const actual = jest.requireActual("@cocalc/frontend/components");
  return {
    ...actual,
    TimeAgo: ({ date }: any) => (
      <span>{date instanceof Date ? date.toISOString() : String(date)}</span>
    ),
  };
});

describe("CodexActivity terminal rows", () => {
  it('renders "No output." after the terminal block', () => {
    const { container } = render(
      React.createElement(TerminalRow, {
        fontSize: 14,
        entry: {
          kind: "terminal",
          id: "terminal-1",
          seq: 1,
          terminalId: "term-1",
          command: "echo hi",
          args: [],
          cwd: "/root",
          output: "",
          completed: true,
        },
      }),
    );

    const prompt = container.querySelector(
      "pre.cocalc-slate-code-block",
    ) as HTMLElement | null;
    const empty = screen.getByText("No output.");

    expect(prompt).not.toBeNull();
    expect(
      prompt!.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders shell payload as input without a fake prompt line", () => {
    const { container } = render(
      React.createElement(TerminalRow, {
        fontSize: 14,
        entry: {
          kind: "terminal",
          id: "terminal-3",
          seq: 3,
          terminalId: "term-3",
          command: "/bin/bash",
          args: ["-lc", "printf 'hi\\nthere'"],
          cwd: "/root",
          output: "hi\nthere\n",
          completed: true,
        },
      }),
    );

    expect(screen.getByText("Input")).not.toBeNull();
    expect(screen.getByText("Output")).not.toBeNull();
    expect(container.textContent).toContain("printf 'hi\\nthere'");
    expect(container.textContent).not.toContain("~/root$");
    expect(container.textContent).not.toContain("$ printf");
  });

  it("shows a visible per-row timestamp", () => {
    render(
      React.createElement(TerminalRow, {
        fontSize: 14,
        entry: {
          kind: "terminal",
          id: "terminal-2",
          seq: 2,
          time: Date.parse("2026-03-15T18:00:00.000Z"),
          terminalId: "term-2",
          command: "echo hi",
          args: [],
          cwd: "/root",
          output: "hi\n",
          completed: true,
        },
      }),
    );

    expect(screen.getByText("2026-03-15T18:00:00.000Z")).not.toBeNull();
  });

  it("renders inline shell strings as input", () => {
    const { container } = render(
      React.createElement(TerminalRow, {
        fontSize: 14,
        entry: {
          kind: "terminal",
          id: "terminal-4",
          seq: 4,
          terminalId: "term-4",
          command: "/bin/bash -lc 'pwd && ls -la'",
          cwd: "/root",
          output: "/root\nfile.txt\n",
          completed: true,
        },
      }),
    );

    expect(screen.getByText("Input")).not.toBeNull();
    expect(container.textContent).toContain("pwd && ls -la");
  });

  it('does not leave "Waiting for output…" after a finished turn without terminal exit output', () => {
    render(
      React.createElement(CodexActivity, {
        expanded: true,
        events: [
          { type: "status", state: "running", seq: 1, time: 1000 } as any,
          {
            type: "event",
            seq: 2,
            time: 1010,
            event: {
              type: "terminal",
              terminalId: "term-5",
              phase: "start",
              command: "/bin/bash -lc 'sleep 10'",
              cwd: "/root",
            },
          } as any,
          {
            type: "summary",
            seq: 3,
            time: 1020,
            finalResponse: "Done.",
          } as any,
        ],
      }),
    );

    expect(screen.queryByText("Waiting for output…")).toBeNull();
    expect(screen.getByText("No output.")).not.toBeNull();
  });

  it("renders generated image events with prompt and saved path", () => {
    render(
      React.createElement(CodexActivity, {
        expanded: true,
        events: [
          {
            type: "event",
            seq: 1,
            time: Date.parse("2026-04-21T18:00:00.000Z"),
            event: {
              type: "image",
              id: "img-1",
              status: "completed",
              revisedPrompt: "A reconnect architecture diagram",
              savedPath: "/tmp/project/.codex/generated_images/img-1.png",
            },
          } as any,
        ],
      }),
    );

    expect(screen.getByText("Generated image")).not.toBeNull();
    expect(screen.getByText("A reconnect architecture diagram")).not.toBeNull();
    expect(
      screen.getByText("/tmp/project/.codex/generated_images/img-1.png"),
    ).not.toBeNull();
  });
});
