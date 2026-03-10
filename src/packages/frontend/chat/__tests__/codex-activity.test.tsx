import React from "react";
import { render, screen } from "@testing-library/react";
import { TerminalRow } from "../codex-activity";

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
});
