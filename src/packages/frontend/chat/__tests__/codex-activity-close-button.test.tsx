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
});
