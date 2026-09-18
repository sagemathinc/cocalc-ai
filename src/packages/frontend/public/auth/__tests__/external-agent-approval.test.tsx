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

const sessionId = "11111111-1111-4111-8111-111111111111";
const api = jest.mocked(postAuthApi);
const props = {
  challengeId: "challenge",
  originBayId: "origin",
  label: "External security assistant",
  isAuthenticated: true,
};
const directory = {
  enabled: true,
  sessions: [
    {
      agent_session_id: sessionId,
      title: "Security review",
      state: "active",
      delivery_mode: "queued",
      members: [],
    },
  ],
  usage: { active_sessions: 1, session_limit: 100, member_limit: 8 },
  controls: { paused: false, generation: 0 },
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
  api.mockReset().mockResolvedValue(directory as any);
});

test("human selects one complete-graph session and approves at the home origin", async () => {
  const user = userEvent.setup();
  render(<ExternalAgentApproval {...props} />);
  const select = await screen.findByRole("combobox", { name: "Agent Session" });
  await user.click(select);
  await user.click(await screen.findByText(/Security review/));
  await user.click(
    screen.getByRole("button", { name: "Approve Session Membership" }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith({
      origin: "https://home.test",
      endpoint: "auth/cli/agent/approve",
      body: {
        challenge_id: "challenge",
        origin_bay_id: "origin",
        agent_session_id: sessionId,
        ttl_seconds: 86400,
      },
    }),
  );
  expect(await screen.findByRole("status")).toBeTruthy();
});

test("signed-out visitors cannot enumerate or approve sessions", () => {
  render(<ExternalAgentApproval {...props} isAuthenticated={false} />);
  expect(screen.queryByRole("combobox", { name: "Agent Session" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Approve Session Membership" }),
  ).toBeNull();
  expect(api).not.toHaveBeenCalled();
});
