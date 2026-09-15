/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExternalAgentInstallations } from "../external-installations";
import { postAuthApi } from "@cocalc/frontend/auth/api";

jest.mock("@cocalc/frontend/auth/api", () => ({ postAuthApi: jest.fn() }));
jest.mock("@cocalc/frontend/control-plane-origin", () => ({
  getControlPlaneOrigin: () => "https://home.test",
}));
const mockBound = jest.fn();
jest.mock("../use-bound-account", () => ({
  useBoundAgentAccount: () => ({ assertCurrent: () => mockBound() }),
}));

const installation = {
  installation_id: "test-installation",
  label: "Security assistant",
  state: "active",
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  destinations: [],
};
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ matches: false, addListener() {}, removeListener() {} }),
  });
});
beforeEach(() => {
  jest
    .mocked(postAuthApi)
    .mockReset()
    .mockResolvedValue({ enabled: true, installations: [installation] });
  mockBound.mockReset();
});

test("keyboard revocation removes action and restores focus to the section heading", async () => {
  const user = userEvent.setup();
  render(<ExternalAgentInstallations />);
  const revoke = await screen.findByRole("button", {
    name: "Revoke Security assistant",
  });
  await user.tab();
  expect(document.activeElement).toBe(revoke);
  jest.mocked(postAuthApi).mockResolvedValueOnce({
    enabled: true,
    installations: [{ ...installation, state: "revoked" }],
  });
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "External Agent Installations" }),
    ),
  );
  expect(
    screen.queryByRole("button", { name: "Revoke Security assistant" }),
  ).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("revoked");
  expect(postAuthApi).toHaveBeenLastCalledWith({
    origin: "https://home.test",
    endpoint: "auth/cli/agent/installations",
    body: { action: "revoke", installation_id: installation.installation_id },
  });
});

test("changed account prevents an action rather than reusing the new session", async () => {
  const user = userEvent.setup();
  render(<ExternalAgentInstallations />);
  const revoke = await screen.findByRole("button", {
    name: "Revoke Security assistant",
  });
  mockBound.mockImplementation(() => {
    throw new Error("account changed");
  });
  await user.click(revoke);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(postAuthApi).toHaveBeenCalledTimes(1);
});

test("site kill switch leaves existing installations inspectable and revocable", async () => {
  jest
    .mocked(postAuthApi)
    .mockResolvedValue({ enabled: false, installations: [installation] });
  const user = userEvent.setup();
  render(<ExternalAgentInstallations />);
  const revoke = await screen.findByRole("button", {
    name: "Revoke Security assistant",
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "External sending is disabled",
  );
  await user.click(revoke);
  expect(postAuthApi).toHaveBeenLastCalledWith({
    origin: "https://home.test",
    endpoint: "auth/cli/agent/installations",
    body: { action: "revoke", installation_id: installation.installation_id },
  });
});
