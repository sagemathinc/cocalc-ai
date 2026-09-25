import { fireEvent, render, screen } from "@testing-library/react";
import { ActionListArtifact } from "./action-list-artifact";
const proposal = {
  id: "reply",
  title: "Reply",
  target: "Ticket 123",
  draft: "Initial reply",
};
const artifact: any = {
  title: "Support",
  artifact_id: "a",
  thread_id: "t",
  input: "",
  actions: [proposal],
};
beforeEach(() => localStorage.clear());
async function approve() {
  fireEvent.mouseDown(
    screen.getByRole("combobox", { name: "Decision for Reply" }),
  );
  fireEvent.click(await screen.findByText("Approve exact draft"));
}
test("stages exact decisions and invalidates approval after a draft edit", async () => {
  const onReview = jest.fn().mockResolvedValue(undefined);
  render(
    <ActionListArtifact
      artifact={artifact}
      historical={false}
      onReview={onReview}
    />,
  );
  await approve();
  fireEvent.change(screen.getByRole("textbox", { name: "Draft for Reply" }), {
    target: { value: "Edited reply" },
  });
  const button = screen.getByRole("button", {
    name: "Return decisions to agent",
  });
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  expect(onReview).toHaveBeenCalledWith(
    expect.objectContaining({
      action_review: [
        expect.objectContaining({
          decision: "undecided",
          proposal: expect.objectContaining({ draft: "Edited reply" }),
        }),
      ],
    }),
  );
});
test("changed agent proposal blocks stale review until explicitly adopted", async () => {
  const onReview = jest.fn().mockResolvedValue(undefined);
  const { rerender } = render(
    <ActionListArtifact
      artifact={artifact}
      historical={false}
      onReview={onReview}
    />,
  );
  await approve();
  rerender(
    <ActionListArtifact
      artifact={{
        ...artifact,
        actions: [{ ...proposal, draft: "Agent revision" }],
      }}
      historical={false}
      onReview={onReview}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Return decisions to agent" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Use updated proposal" }));
  expect(screen.getByRole("textbox", { name: "Draft for Reply" })).toHaveValue(
    "Agent revision",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Return decisions to agent" }),
  );
  expect(onReview.mock.calls[0][0].action_review[0].decision).toBe("undecided");
});
test("read-only and historical views cannot stage decisions", () => {
  render(
    <ActionListArtifact artifact={artifact} historical onReview={jest.fn()} />,
  );
  expect(
    screen.getByRole("button", { name: "Return decisions to agent" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("textbox", { name: "Draft for Reply" }),
  ).toBeDisabled();
});

test("restores exact drafts after reopening and isolates review storage", async () => {
  const onReview = jest.fn().mockResolvedValue(undefined);
  const first = render(
    <ActionListArtifact
      artifact={artifact}
      historical={false}
      storageKey="account:project:chat:thread:artifact"
      onReview={onReview}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Draft for Reply" }), {
    target: { value: "My edited reply" },
  });
  await approve();
  first.unmount();
  const second = render(
    <ActionListArtifact
      artifact={artifact}
      historical={false}
      storageKey="account:project:chat:thread:artifact"
      onReview={onReview}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Draft for Reply" })).toHaveValue(
    "My edited reply",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Return decisions to agent" }),
  );
  expect(onReview.mock.calls[0][0].action_review[0]).toMatchObject({
    decision: "approve",
    proposal: { draft: "My edited reply" },
  });
  second.unmount();
  render(
    <ActionListArtifact
      artifact={artifact}
      historical={false}
      storageKey="another-account:project:chat:thread:artifact"
      onReview={onReview}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Draft for Reply" })).toHaveValue(
    "Initial reply",
  );
});

test("ignores malformed saved reviews and treats inherited object names as normal ids", () => {
  localStorage.setItem("broken-review", '{"decision":"approve"}');
  render(
    <ActionListArtifact
      artifact={{ ...artifact, actions: [{ ...proposal, id: "__proto__" }] }}
      historical={false}
      storageKey="broken-review"
      onReview={jest.fn()}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Draft for Reply" })).toHaveValue(
    "Initial reply",
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Draft for Reply" }), {
    target: { value: "Edited" },
  });
  expect(screen.getByRole("textbox", { name: "Draft for Reply" })).toHaveValue(
    "Edited",
  );
});
