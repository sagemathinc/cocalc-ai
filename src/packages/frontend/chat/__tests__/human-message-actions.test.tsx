import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { fromJS } from "immutable";
import Message from "../message";
jest.mock("../git-commit-drawer", () => ({
  GitCommitDrawer: () => null,
}));

jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

function renderMessage(feedback: object = {}) {
  const actions = {
    isLanguageModelThread: () => false,
    getMessagesInThread: () => [],
    getThreadMetadata: () => ({ agent_kind: "none" }),
    store: { get: () => undefined },
    feedback: jest.fn(),
  } as any;
  const message = {
    date: 2000,
    message_id: "human-message",
    thread_id: "human-thread",
    sender_id: "viewer",
    feedback: fromJS(feedback),
    history: [{ content: "Hello world" }],
  };
  const view = render(
    <IntlProvider locale="en">
      <Message
        project_id="project"
        path="human.chat"
        index={0}
        actions={actions}
        message={message as any}
        messages={new Map([["2000", message]])}
        account_id="viewer"
        get_user_name={() => "Viewer"}
        mode="standalone"
        is_thread_body={false}
      />
    </IntlProvider>,
  );
  return { ...view, actions, message };
}

test("human message actions live in a keyboard-accessible header menu, with zero likes hidden", async () => {
  const user = userEvent.setup();
  const { container, actions, message } = renderMessage();
  expect(
    container.querySelector('[data-testid="chat-message-actions"]'),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: /Like message/ })).toBeNull();
  const trigger = screen.getByRole("button", { name: "More message actions" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const like = await screen.findByRole("menuitem", { name: "Like message" });
  await waitFor(() => expect(like).toBeVisible());
  expect(
    screen.getByRole("menuitem", { name: "Copy whole message" }),
  ).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "Edit message" })).toBeVisible();
  expect(
    screen.getByRole("menuitem", { name: "Delete message" }),
  ).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "Focus message" })).toBeVisible();
  act(() => like.focus());
  fireEvent.keyDown(like, { key: "Enter", which: 13, keyCode: 13 });
  expect(actions.feedback).toHaveBeenCalledWith(message, "positive");
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.keyboard("{Enter}");
  await screen.findByRole("menuitem", { name: "Like message" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.keyboard("{Enter}");
  const focus = await screen.findByRole("menuitem", { name: "Focus message" });
  await waitFor(() => expect(focus).toBeVisible());
  act(() => focus.focus());
  fireEvent.keyDown(focus, { key: "Enter", which: 13, keyCode: 13 });
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
});

test("nonzero likes remain visible beside the menu and can be removed", async () => {
  const user = userEvent.setup();
  const { actions, message } = renderMessage({ viewer: "positive" });
  const like = screen.getByRole("button", { name: "Unlike message (1)" });
  expect(like).toHaveAttribute("aria-pressed", "true");
  await user.click(like);
  expect(actions.feedback).toHaveBeenCalledWith(message, null);
});
