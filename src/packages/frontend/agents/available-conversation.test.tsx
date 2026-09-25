import { fireEvent, render, screen } from "@testing-library/react";
import { AvailableConversation } from "./available-conversation";

it("does not mount a conversation loader for an unavailable agent and exposes a focusable retry", () => {
  const mounted = jest.fn();
  function Chat() {
    mounted();
    return <div>Conversation</div>;
  }
  const retry = jest.fn();
  const { rerender } = render(
    <AvailableConversation available={false} retry={retry}>
      <Chat />
    </AvailableConversation>,
  );
  expect(mounted).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Agent conversation unavailable",
  );
  const button = screen.getByRole("button", { name: "Retry connection" });
  button.focus();
  expect(button).toHaveFocus();
  fireEvent.click(button);
  expect(retry).toHaveBeenCalledTimes(1);
  rerender(
    <AvailableConversation available retry={retry}>
      <Chat />
    </AvailableConversation>,
  );
  expect(screen.getByText("Conversation")).toBeInTheDocument();
});
