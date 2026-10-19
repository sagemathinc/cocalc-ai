/** @jest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react";
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

const networkId = "11111111-1111-4111-8111-111111111111";
const api = jest.mocked(postAuthApi);
const props = {
  challengeId: "challenge",
  originBayId: "origin",
  label: "External security assistant",
  isAuthenticated: true,
};
const directory = {
  enabled: true,
  networks: [
    {
      agent_network_id: networkId,
      account_id: "22222222-2222-4222-8222-222222222222",
      title: "Security review",
      state: "active",
      delivery_mode: "queued",
      generation: "33333333-3333-4333-8333-333333333333",
      created_by: "22222222-2222-4222-8222-222222222222",
      created_at: "2026-09-20T00:00:00.000Z",
      updated_at: "2026-09-20T00:00:00.000Z",
      members: [],
    },
  ],
  usage: { active_networks: 1, network_limit: 100, member_limit: 8 },
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

test("human selects one complete-graph network and approves at the home origin", async () => {
  const user = userEvent.setup();
  render(<ExternalAgentApproval {...props} />);
  const select = await screen.findByRole("combobox", { name: "Agent Network" });
  await user.click(select);
  await user.click(await screen.findByText(/Security review/));
  await user.click(
    screen.getByRole("button", { name: "Approve Network Membership" }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith({
      origin: "https://home.test",
      endpoint: "auth/cli/agent/approve",
      body: {
        challenge_id: "challenge",
        origin_bay_id: "origin",
        agent_network_id: networkId,
        ttl_seconds: 86400,
      },
    }),
  );
  expect(await screen.findByRole("status")).toBeTruthy();
});

test("signed-out visitors cannot enumerate or approve networks", () => {
  render(<ExternalAgentApproval {...props} isAuthenticated={false} />);
  expect(screen.queryByRole("combobox", { name: "Agent Network" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Approve Network Membership" }),
  ).toBeNull();
  expect(api).not.toHaveBeenCalled();
});

test("an expired request says so as soon as the page opens, with no form", async () => {
  render(<ExternalAgentApproval {...props} expiresInMs={0} state="pending" />);
  expect(
    await screen.findByText("This enrollment request is no longer open."),
  ).toBeTruthy();
  expect(
    screen.getByText(/It expired at .*Run the enrollment command/),
  ).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Agent Network" })).toBeNull();
  expect(api).not.toHaveBeenCalled();
});

test("an already approved request is not offered again", async () => {
  render(
    <ExternalAgentApproval
      {...props}
      expiresInMs={30 * 60_000}
      state="redeemed"
    />,
  );
  expect(await screen.findByText(/It was already approved\./)).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Agent Network" })).toBeNull();
});

test("the page shows when the request expires, and warns when it is soon", async () => {
  const { unmount } = render(
    <ExternalAgentApproval
      {...props}
      expiresInMs={50 * 60_000}
      state="pending"
    />,
  );
  expect(
    await screen.findByText(/^This request expires at [^(]*\.$/),
  ).toBeTruthy();
  expect(
    await screen.findByRole("combobox", { name: "Agent Network" }),
  ).toBeTruthy();
  unmount();
  render(
    <ExternalAgentApproval
      {...props}
      expiresInMs={4 * 60_000}
      state="pending"
    />,
  );
  expect(
    await screen.findByText(
      /This request expires at .*\(in about 4 minutes\)\./,
    ),
  ).toBeTruthy();
});

test("a browser clock far ahead of the server's still offers a fresh request", async () => {
  const now = jest
    .spyOn(Date, "now")
    .mockReturnValue(Date.now() + 2 * 3600_000);
  try {
    render(
      <ExternalAgentApproval
        {...props}
        expiresInMs={50 * 60_000}
        state="pending"
      />,
    );
    expect(
      await screen.findByRole("combobox", { name: "Agent Network" }),
    ).toBeTruthy();
    expect(
      screen.queryByText("This enrollment request is no longer open."),
    ).toBeNull();
  } finally {
    now.mockRestore();
  }
});

test("the page counts the server's time left down and closes when it runs out", () => {
  jest.useFakeTimers();
  try {
    render(
      <ExternalAgentApproval {...props} expiresInMs={60_000} state="pending" />,
    );
    expect(
      screen.queryByText("This enrollment request is no longer open."),
    ).toBeNull();
    act(() => {
      jest.advanceTimersByTime(75_000);
    });
    expect(
      screen.getByText("This enrollment request is no longer open."),
    ).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

test("the form closes exactly when the server's time runs out, not at the next tick", () => {
  jest.useFakeTimers();
  try {
    render(
      <ExternalAgentApproval {...props} expiresInMs={5_000} state="pending" />,
    );
    act(() => {
      jest.advanceTimersByTime(4_900);
    });
    expect(
      screen.queryByText("This enrollment request is no longer open."),
    ).toBeNull();
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(
      screen.getByText("This enrollment request is no longer open."),
    ).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});
