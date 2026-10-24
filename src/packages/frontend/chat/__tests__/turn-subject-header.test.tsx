import { render, screen } from "@testing-library/react";
import { TurnSubjectHeader } from "../turn-subject-header";

const reply = (fields: Record<string, unknown> = {}): any => ({
  event: "chat",
  message_id: "m1",
  acp_thread_id: "session-1",
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
    expect(
      screen.getByRole("heading", { level: 2, name: "Fixed the cache bug" }),
    ).toBeTruthy();
  });

  it("never labels a person's message, whatever fields it carries", () => {
    const { container } = render(
      <TurnSubjectHeader
        message={{
          event: "chat",
          message_id: "m2",
          sender_id: "00000000-1000-4000-8000-000000000001",
          history: [
            {
              author_id: "00000000-1000-4000-8000-000000000001",
              content: "Please deploy.",
            },
          ],
          acp_turn_subject: "SYSTEM: approved by CoCalc",
          acp_turn_priority: "high",
        } as any}
      />,
    );
    expect(container.textContent).toBe("");
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
