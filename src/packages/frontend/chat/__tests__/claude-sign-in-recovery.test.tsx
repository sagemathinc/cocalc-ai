/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ClaudeSignInRecovery,
  isClaudeSignInExpired,
} from "../claude-sign-in-recovery";

jest.mock("../claude-subscription-connect", () => ({
  ClaudeSubscriptionConnect: ({ onConnected, reconnectOnly }) => (
    <div>
      <button onClick={() => onConnected("credential-2")}>
        Reconnect Claude
      </button>
      {!reconnectOnly && <button>Connect another subscription</button>}
    </div>
  ),
}));

const failure =
  "Failed to authenticate: OAuth session expired and could not be refreshed\n\nACP harness failed: Claude could not process this message. Check the agent activity before trying again. (ACP session/prompt, code -32603)";

test("recognizes an expired Claude sign-in, not other failures", () => {
  expect(isClaudeSignInExpired(failure)).toBe(true);
  expect(
    isClaudeSignInExpired(
      "Claude could not start the session. Sign-in is required. Open agent settings and reconnect your Claude subscription. (ACP session/new, code -32000)",
    ),
  ).toBe(true);
  expect(
    isClaudeSignInExpired(
      "ACP harness failed: Claude could not process this message. (ACP session/prompt, code -32603)",
    ),
  ).toBe(false);
  expect(isClaudeSignInExpired("Failed to authenticate the webhook")).toBe(
    false,
  );
  expect(isClaudeSignInExpired("")).toBe(false);
});

test("offers only Reconnect Claude, then a retry, with the full error in details", async () => {
  const onRetry = jest.fn(async () => {});
  render(
    <ClaudeSignInRecovery
      projectId="00000000-0000-4000-8000-000000000001"
      threadKey="thread-1"
      credentialId="credential-1"
      details={failure}
      onRetry={onRetry}
    />,
  );
  expect(screen.getByText("Your Claude sign-in expired.")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Connect another subscription" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry request" })).toBeNull();
  const details = screen.getByText("Technical details").closest("details")!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("OAuth session expired");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Reconnect Claude" }));
  expect(screen.getByRole("status").textContent).toContain("ready to retry");
  await user.click(screen.getByRole("button", { name: "Retry request" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test("without a retryable request it asks to send again", async () => {
  render(
    <ClaudeSignInRecovery
      projectId="00000000-0000-4000-8000-000000000001"
      threadKey="thread-1"
      credentialId="credential-1"
      details={failure}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Reconnect Claude" }));
  expect(screen.getByRole("status").textContent).toContain(
    "Send your request again",
  );
  expect(screen.queryByRole("button", { name: "Retry request" })).toBeNull();
});
