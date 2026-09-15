/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { postAuthApi } from "@cocalc/frontend/auth/api";
import { ExternalAgentApproval } from "../external-agent-approval";

jest.mock("@cocalc/frontend/auth/api", () => ({ postAuthApi: jest.fn() }));
jest.mock("@cocalc/frontend/control-plane-origin", () => ({
  getControlPlaneOrigin: () => "https://home.test",
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  useFreshAuthAction: () => ({
    runFreshAuthAction: async (fn) => fn(),
    freshAuthModalProps: {},
  }),
  FreshAuthModal: () => null,
}));

const endpoint = {
  project_id: "11111111-1111-4111-8111-111111111111",
  agent_id: "22222222-2222-4222-8222-222222222222",
};
const api = jest.mocked(postAuthApi);
const props = {
  challengeId: "challenge",
  originBayId: "origin",
  label: "External security assistant",
  isAuthenticated: true,
};
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
});
beforeEach(() => {
  api
    .mockReset()
    .mockResolvedValue({
      enabled: true,
      agents: [
        {
          name: "reviewer",
          available: true,
          endpoint,
          project_title: "Security",
          thread_title: "Review",
        },
      ],
    });
});

test("keyboard selection grants only the selected recipient at the home origin", async () => {
  const user = userEvent.setup();
  render(<ExternalAgentApproval {...props} />);
  const checkbox = await screen.findByRole("checkbox", { name: /reviewer/ });
  const approve = screen.getByRole("button", {
    name: "Approve Send-Only Access",
  });
  expect((approve as HTMLButtonElement).disabled).toBe(true);
  await user.tab();
  expect(document.activeElement).toBe(checkbox);
  await user.keyboard(" ");
  expect((checkbox as HTMLInputElement).checked).toBe(true);
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("combobox", { name: "Credential expires after" }),
  );
  await user.tab();
  expect(document.activeElement).toBe(approve);
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith({
      origin: "https://home.test",
      endpoint: "auth/cli/agent/approve",
      body: {
        challenge_id: "challenge",
        origin_bay_id: "origin",
        targets: [endpoint],
        ttl_seconds: 86400,
      },
    }),
  );
  expect(await screen.findByRole("status")).toBeTruthy();
  expect(
    api.mock.calls.some(([opts]) => opts.endpoint === "auth/cli/login/approve"),
  ).toBe(false);
});

test("failed approval stays visible and preserves selection for an explicit retry", async () => {
  const user = userEvent.setup();
  render(<ExternalAgentApproval {...props} />);
  const checkbox = await screen.findByRole("checkbox", { name: /reviewer/ });
  await user.click(checkbox);
  api.mockRejectedValueOnce(new Error("challenge expired"));
  await user.click(
    screen.getByRole("button", { name: "Approve Send-Only Access" }),
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("challenge expired"),
  );
  expect((checkbox as HTMLInputElement).checked).toBe(true);
  expect(api).toHaveBeenCalledTimes(2);
});

test("signed-out visitors cannot enumerate or approve destinations", async () => {
  render(<ExternalAgentApproval {...props} isAuthenticated={false} />);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Approve Send-Only Access" }),
  ).toBeNull();
  expect(api).not.toHaveBeenCalled();
});
