import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useFeedbackDestination } from "./feedback-destination";
import { submitNavigatorPromptInWorkspaceChat } from "@cocalc/frontend/project/new/navigator-intents";

const session = {
  session_id: "s",
  chat_path: "many.chat",
  thread_key: "original",
};
jest.mock("@cocalc/frontend/project/new/navigator-intents", () => ({
  submitNavigatorPromptInWorkspaceChat: jest.fn(),
}));
jest.mock("@cocalc/frontend/frame-editors/ai/agent-session-selector", () => {
  const React = require("react");
  return {
    usePersistentAgentSessionSelection: () => {
      const [id, setId] = React.useState("s");
      return {
        selectedSessionId: id,
        setSelectedSessionId: setId,
        selectedAgentSession: id === "s" ? session : undefined,
        loading: false,
        saveSelectedAgentSession: jest.fn(),
      };
    },
    isNewAgentThreadSelection: (selection) =>
      selection.selectedSessionId === "new",
    AgentSessionError: () => null,
    AgentSessionSelect: ({ selection, includeNewThreadOption }) => (
      <select
        aria-label="Recent agent sessions"
        value={selection.selectedSessionId}
        onChange={(e) => selection.setSelectedSessionId(e.target.value)}
      >
        <option value="s">Existing agent</option>
        {includeNewThreadOption && (
          <option value="new">New agent thread</option>
        )}
      </select>
    ),
  };
});

function Harness({
  result,
  open = true,
}: {
  result: jest.Mock;
  open?: boolean;
}) {
  const destination = useFeedbackDestination("p", "review.chat", open);
  return (
    <>
      <button
        onClick={() =>
          void destination.request!("Pinned review", { title: "Review" }).then(
            () => result("sent"),
            () => result("cancelled"),
          )
        }
      >
        Send review
      </button>
      {destination.modal}
    </>
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(submitNavigatorPromptInWorkspaceChat).mockResolvedValue(true);
});

test.each([false, true])(
  "selects an existing agent or explicitly creates a new one (%s)",
  async (createNewThread) => {
    const user = userEvent.setup();
    const result = jest.fn();
    render(<Harness result={result} />);
    await user.click(screen.getByRole("button", { name: "Send review" }));
    const selector = screen.getByRole("combobox", {
      name: "Recent agent sessions",
    });
    await waitFor(() => expect(selector).toHaveFocus());
    if (createNewThread) await user.selectOptions(selector, "new");
    const send = screen.getByRole("button", { name: "Send feedback" });
    send.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(result).toHaveBeenCalledWith("sent"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send review" })).toHaveFocus(),
    );
    expect(submitNavigatorPromptInWorkspaceChat).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Pinned review",
        project_id: "p",
        path: "review.chat",
        agentSession: createNewThread ? undefined : session,
        createNewThread,
      }),
    );
  },
);

test.each(["Escape", "Cancel"])(
  "%s cancels without submitting feedback and restores focus",
  async (method) => {
    const user = userEvent.setup();
    const result = jest.fn();
    render(<Harness result={result} />);
    await user.click(screen.getByRole("button", { name: "Send review" }));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Recent agent sessions" }),
      ).toHaveFocus(),
    );
    if (method === "Escape") await user.keyboard("{Escape}");
    else await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(result).toHaveBeenCalledWith("cancelled"));
    expect(submitNavigatorPromptInWorkspaceChat).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send review" })).toHaveFocus(),
    );
  },
);

test("closing the review cancels destination selection", async () => {
  const user = userEvent.setup();
  const result = jest.fn();
  const view = render(<Harness result={result} />);
  await user.click(screen.getByRole("button", { name: "Send review" }));
  view.rerender(<Harness result={result} open={false} />);
  await waitFor(() => expect(result).toHaveBeenCalledWith("cancelled"));
  expect(submitNavigatorPromptInWorkspaceChat).not.toHaveBeenCalled();
});

test("failed delivery keeps the review pending for retry", async () => {
  const user = userEvent.setup();
  const result = jest.fn();
  jest
    .mocked(submitNavigatorPromptInWorkspaceChat)
    .mockResolvedValueOnce(false);
  render(<Harness result={result} />);
  await user.click(screen.getByRole("button", { name: "Send review" }));
  await user.click(screen.getByRole("button", { name: "Send feedback" }));
  await screen.findByText(/Unable to send review feedback/);
  expect(result).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Send feedback" }));
  await waitFor(() => expect(result).toHaveBeenCalledWith("sent"));
});
