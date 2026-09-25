import { fireEvent, render, screen } from "@testing-library/react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { CopyAgentModal } from "./copy-agent-modal";

const agent = { name: "source" } as NamedAgent;

test("typing validates locally without rerendering the parent or submitting", () => {
  const onCopy = jest.fn();
  const parentRender = jest.fn();
  function Parent() {
    parentRender();
    return (
      <CopyAgentModal
        agent={agent}
        agents={[agent]}
        initialName="agent-copy"
        busy={false}
        error=""
        onCopy={onCopy}
        onCancel={jest.fn()}
      />
    );
  }
  render(<Parent />);
  const renders = parentRender.mock.calls.length;
  const input = screen.getByRole("textbox", { name: "Agent name" });
  input.focus();
  for (const value of ["source", "invalid name", ""]) {
    fireEvent.change(input, { target: { value } });
    expect(
      (screen.getByRole("button", { name: "Copy agent" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    fireEvent.keyUp(input, { key: "Enter", keyCode: 13 });
  }
  fireEvent.change(input, { target: { value: "new-name" } });
  expect(parentRender).toHaveBeenCalledTimes(renders);
  expect(onCopy).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
  expect(onCopy).toHaveBeenCalledWith("new-name");
});

test("submission errors preserve the draft and busy state prevents submission", () => {
  const props = {
    agent,
    agents: [agent],
    initialName: "agent-copy",
    busy: false,
    error: "",
    onCopy: jest.fn(),
    onCancel: jest.fn(),
  };
  const { rerender } = render(<CopyAgentModal {...props} />);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "my-copy" },
  });
  rerender(<CopyAgentModal {...props} error="Name already taken" />);
  expect(screen.getByRole("alert").textContent).toContain("Name already taken");
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
    "my-copy",
  );
  rerender(<CopyAgentModal {...props} busy />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", keyCode: 13 });
  expect(props.onCopy).not.toHaveBeenCalled();
});
