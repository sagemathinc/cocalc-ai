import { render, screen } from "@testing-library/react";
import CodexActivity from "../codex-activity";

describe("CodexActivity thinking entries", () => {
  it("labels the agent's thinking so it is not read as a reply", () => {
    render(
      <CodexActivity
        expanded
        events={[
          {
            type: "event",
            seq: 1,
            event: { type: "thinking", text: "The image is a banner." },
          },
          {
            type: "event",
            seq: 2,
            event: { type: "message", text: "Here is my answer." },
          },
        ]}
      />,
    );
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("The image is a banner.")).toBeInTheDocument();
  });
});
