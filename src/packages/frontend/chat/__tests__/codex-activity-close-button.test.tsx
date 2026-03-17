import { render, screen } from "@testing-library/react";
import CodexActivity from "../codex-activity";

describe("CodexActivity close button", () => {
  it("renders a single hide-log button in expanded mode", () => {
    render(
      <CodexActivity
        expanded
        events={[
          {
            type: "event",
            seq: 1,
            event: { type: "thinking", text: "working" },
          },
        ]}
      />,
    );

    expect(screen.getAllByLabelText("Hide log")).toHaveLength(1);
  });

  it("does not change hook order when activity entries appear later", () => {
    const { rerender } = render(<CodexActivity expanded events={[]} />);

    rerender(
      <CodexActivity
        expanded
        events={[
          {
            type: "event",
            seq: 1,
            event: { type: "thinking", text: "working" },
          },
        ]}
      />,
    );

    expect(screen.getAllByLabelText("Hide log")).toHaveLength(1);
  });
});
