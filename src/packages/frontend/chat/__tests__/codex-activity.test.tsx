import React from "react";
import { render, screen } from "@testing-library/react";
import { TerminalRow } from "../codex-activity";

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
});
