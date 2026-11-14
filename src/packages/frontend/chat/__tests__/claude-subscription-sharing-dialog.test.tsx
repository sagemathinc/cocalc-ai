/** @jest-environment jsdom */
// The warning dialog itself, as rendered (not mocked): its name, the full
// text, keyboard use, and where focus goes.
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { fromJS } from "immutable";
import {
  SHARING_TEXT,
  SHARING_TITLE,
  confirmClaudeSubscriptionSharing,
} from "../claude-subscription-sharing";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (name: string) =>
      name === "projects"
        ? {
            getIn: (path: string[]) =>
              fromJS({
                "project-a": {
                  users: { "account-a": {}, "account-b": {} },
                },
              }).getIn(path.slice(1)),
          }
        : name === "customize"
          ? { get: () => "project" }
          : undefined,
  },
  useTypedRedux: () => undefined,
}));

const subscription = {
  version: 1,
  provider: "anthropic",
  mode: "account-subscription",
  credentialId: "00000000-0000-4000-8000-000000000001",
} as const;

function ask() {
  return confirmClaudeSubscriptionSharing({
    accountId: "account-a",
    projectId: "project-a",
    credential: subscription,
  });
}

beforeEach(() => localStorage.clear());

test("the warning is a named dialog with the full text, Escape cancels, and focus returns", async () => {
  render(<button type="button">Send</button>);
  const send = screen.getByRole("button", { name: "Send" });
  send.focus();
  let answer: Promise<boolean>;
  act(() => {
    answer = ask();
  });
  const dialog = await screen.findByRole("dialog", { name: SHARING_TITLE });
  for (const paragraph of SHARING_TEXT)
    expect(dialog.textContent).toContain(paragraph);
  expect(
    screen.getByRole("button", { name: "I understand, start the agent" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Don't start" })).toBeTruthy();
  // focus moves into the dialog
  await waitFor(() =>
    expect(dialog.contains(document.activeElement)).toBe(true),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  // not accepted: the turn is not sent
  await expect(answer!).resolves.toBe(false);
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: SHARING_TITLE })).toBeNull(),
  );
  await waitFor(() => expect(send).toHaveFocus());
});

test("accepting from the keyboard starts the turn and is remembered for these collaborators", async () => {
  let answer: Promise<boolean>;
  act(() => {
    answer = ask();
  });
  const ok = await screen.findByRole("button", {
    name: "I understand, start the agent",
  });
  ok.focus();
  fireEvent.click(ok); // what Enter or Space on a focused button does
  await expect(answer!).resolves.toBe(true);
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: SHARING_TITLE })).toBeNull(),
  );
  // the next turn, same collaborators: no dialog
  await expect(ask()).resolves.toBe(true);
  expect(screen.queryByRole("dialog", { name: SHARING_TITLE })).toBeNull();
});
