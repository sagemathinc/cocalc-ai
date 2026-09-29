import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map } from "immutable";
import { ActiveContent } from "./active-content";
import { recordSignedInSurfaceReady } from "./bootstrap-ux-latency";

let disabled: boolean | undefined;
let accountId: string | undefined;
const accountBindings: Array<{ assertCurrent: () => void }> = [];
const copied = jest.fn();
const actions = { set_active_tab: jest.fn() };
jest.mock("@cocalc/frontend/app-framework", () => ({
  React: { ...require("react"), memo: (component) => component },
  useActions: () => actions,
  redux: { getStore: () => ({ get: () => accountId }) },
  useTypedRedux: (store, field) => {
    if (store === "page" && field === "active_top_tab") return "agents";
    if (store === "account" && field === "other_settings")
      return disabled === undefined
        ? undefined
        : Map({ openai_disabled: disabled });
    if (field === "is_logged_in") return true;
    if (store === "account" && field === "account_id") return accountId;
    if (field === "open_projects") return [];
  },
}));
jest.mock("@cocalc/frontend/antd-bootstrap", () => ({ Alert: () => null }));
jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/components/loading", () => ({
  Loading: () => null,
}));
jest.mock("@cocalc/frontend/customize", () => ({ SiteName: () => null }));
jest.mock("@cocalc/frontend/docs/link", () => ({ DocsLink: () => null }));
jest.mock("@cocalc/frontend/landing-page/connecting", () => ({
  Connecting: () => null,
}));
jest.mock("./kiosk-mode-banner", () => ({ KioskModeBanner: () => null }));
jest.mock("./managed-egress-blocked-screen", () => ({
  ManagedEgressBlockedScreen: () => null,
}));
jest.mock("./error-boundary", () => ({
  CocalcErrorBoundary: ({ children }) => children,
}));
jest.mock("./bootstrap-ux-latency", () => ({
  recordSignedInSurfaceReady: jest.fn(),
}));
jest.mock("./startup-phase", () => ({ markStartupPhaseOnce: jest.fn() }));
jest.mock("./route-components", () => ({
  MyAgentsWorkspacePage: () => {
    const { useBoundAgentAccount } = require("../agents/use-bound-account");
    const binding = useBoundAgentAccount();
    accountBindings.push(binding);
    return (
      <div role="region" aria-label="Agents workspace">
        <button
          onClick={() => {
            binding.assertCurrent();
            copied();
          }}
        >
          Copy agent
        </button>
      </div>
    );
  },
}));

beforeEach(() => {
  disabled = undefined;
  accountId = undefined;
  accountBindings.length = 0;
  jest.clearAllMocks();
});

it("never mounts Agents when AI is disabled", () => {
  disabled = true;
  render(<ActiveContent />);
  expect(screen.queryByRole("region", { name: "Agents workspace" })).toBeNull();
  expect(actions.set_active_tab).toHaveBeenCalledWith("projects");
});

it("unmounts and redirects when the opt-out arrives or changes", () => {
  const { rerender } = render(<ActiveContent />);
  expect(screen.getByRole("region", { name: "Agents workspace" })).toBeTruthy();
  expect(actions.set_active_tab).not.toHaveBeenCalled();
  disabled = true;
  rerender(<ActiveContent />);
  expect(screen.queryByRole("region", { name: "Agents workspace" })).toBeNull();
  expect(actions.set_active_tab).toHaveBeenCalledWith("projects");
});

it("marks the Agents workspace ready for browser automation", () => {
  render(<ActiveContent />);
  expect(recordSignedInSurfaceReady).toHaveBeenCalledWith("agents");
});

it("rebinds workspace actions after account loading without reviving old actions", async () => {
  const user = userEvent.setup();
  const { rerender, unmount } = render(<ActiveContent />);
  const beforeLogin = accountBindings.at(-1)!;
  expect(() => beforeLogin.assertCurrent()).toThrow("The account changed");
  accountId = "account-a";
  rerender(<ActiveContent />);
  const accountA = accountBindings.at(-1)!;
  const copy = screen.getByRole("button", { name: "Copy agent" });
  copy.focus();
  await user.keyboard("{Enter}");
  expect(copied).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(copy);
  expect(() => beforeLogin.assertCurrent()).toThrow("The account changed");

  // Ordinary rerenders retain the workspace; an identity change replaces it.
  rerender(<ActiveContent />);
  expect(screen.getByRole("button", { name: "Copy agent" })).toBe(copy);
  accountId = "account-b";
  rerender(<ActiveContent />);
  expect(screen.getByRole("button", { name: "Copy agent" })).not.toBe(copy);
  expect(() => accountA.assertCurrent()).toThrow("The account changed");
  expect(() => accountBindings.at(-1)!.assertCurrent()).not.toThrow();

  accountId = "account-a";
  rerender(<ActiveContent />);
  expect(() => accountA.assertCurrent()).toThrow("The account changed");
  const current = accountBindings.at(-1)!;
  expect(() => current.assertCurrent()).not.toThrow();
  unmount();
  expect(() => current.assertCurrent()).toThrow("The account changed");
});
