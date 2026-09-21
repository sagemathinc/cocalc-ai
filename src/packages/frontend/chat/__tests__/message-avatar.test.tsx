import { render, screen } from "@testing-library/react";
import { MessageAvatar } from "../message-avatar";

jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: ({ account_id }: { account_id?: string }) => (
    <span data-testid="account-avatar">{account_id}</span>
  ),
}));
jest.mock("@cocalc/frontend/components/icon", () => ({
  Icon: () => <span aria-hidden="true" />,
}));

describe("message avatar identity", () => {
  it("identifies generic ACP without an OpenAI vendor avatar", () => {
    render(<MessageAvatar accountId="codex-agent" agentLabel="ACP agent" />);
    expect(screen.getByRole("img", { name: "ACP agent" })).toBeTruthy();
    expect(screen.queryByTestId("account-avatar")).toBeNull();
  });

  it("retains the authenticated network sender attribution", () => {
    render(<MessageAvatar agentLabel="From @reviewer" />);
    expect(screen.getByRole("img", { name: "From @reviewer" })).toBeTruthy();
  });

  it.each(["codex-agent", "human-account"])(
    "preserves the existing avatar for %s",
    (accountId) => {
      render(<MessageAvatar accountId={accountId} />);
      expect(screen.getByTestId("account-avatar").textContent).toBe(accountId);
      expect(screen.queryByRole("img")).toBeNull();
    },
  );
});
