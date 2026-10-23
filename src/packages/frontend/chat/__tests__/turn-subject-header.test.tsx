import { render, screen } from "@testing-library/react";
import { TurnSubjectHeader } from "../turn-subject-header";

const reply = (fields: Record<string, unknown> = {}) => ({
  event: "chat",
  message_id: "m1",
  history: [{ content: "Done." }],
  ...fields,
});

describe("the turn subject in the log", () => {
  it("shows nothing unless the agent set a subject or priority", () => {
    const { container } = render(<TurnSubjectHeader message={reply()} />);
    expect(container.textContent).toBe("");
    // normal is the default: nothing to say.
    const normal = render(
      <TurnSubjectHeader message={reply({ acp_turn_priority: "normal" })} />,
    );
    expect(normal.container.textContent).toBe("");
  });

  it("shows the agent's subject as a heading on its reply", () => {
    render(
      <TurnSubjectHeader
        message={reply({ acp_turn_subject: "Fixed the cache bug" })}
      />,
    );
    expect(screen.getByTestId("chat-turn-subject").textContent).toBe(
      "Fixed the cache bug",
    );
  });

  it("marks a high priority turn for the reader, not by color alone", () => {
    render(
      <TurnSubjectHeader
        message={reply({
          acp_turn_subject: "Needs your approval",
          acp_turn_priority: "high",
        })}
      />,
    );
    expect(screen.getByLabelText("High priority: for you")).toBeTruthy();
    expect(screen.getByTestId("chat-turn-subject").textContent).toBe(
      "for youNeeds your approval",
    );
  });

  it("names a low priority turn even without a subject", () => {
    render(<TurnSubjectHeader message={reply({ acp_turn_priority: "low" })} />);
    expect(screen.getByLabelText("Low priority").textContent).toBe("fyi");
  });

  it("ignores an invalid priority", () => {
    const { container } = render(
      <TurnSubjectHeader message={reply({ acp_turn_priority: "urgent" })} />,
    );
    expect(container.textContent).toBe("");
  });
});
