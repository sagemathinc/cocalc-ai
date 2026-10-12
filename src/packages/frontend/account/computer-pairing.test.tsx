import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const calls: string[] = [];
const mockApi = {
  createComputerRequest: jest.fn(async () => {
    calls.push("create");
    return {
      request_id: "R-NEW",
      expires_at: Date.now() + 3_600_000,
      pairing_url: "https://bay-2.example.com/c/R-NEW",
    };
  }),
  revokeComputer: jest.fn(async () => {
    calls.push("revoke");
    return { epoch: 2 };
  }),
  listComputerRequests: jest.fn(async () => [
    {
      request_id: "R-NEW",
      name: "m1",
      state: "pending",
      expires_at: Date.now() + 3_600_000,
      // The home bay's URL: not this browser's origin.
      pairing_url: "https://bay-2.example.com/c/R-NEW",
    },
  ]),
  getComputer: jest.fn(),
  approveComputerRequest: jest.fn(),
};
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { conat_client: { hub: { computers: mockApi } } },
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: async (fn: () => unknown) => {
      await fn();
      return true;
    },
    freshAuthModalProps: {},
  }),
}));

import { ReconnectComputer } from "./computer-pairing";

// Time-limited and still within its time: pairing again revokes the old one.
const m1 = {
  computer_id: "1a057860-889d-461a-9073-4b8c69d65123",
  name: "m1",
  hostname: "studio.local",
  machine_user: "sage",
  agent_network_id: "n1",
  connected: false,
  revoked_at: null,
  deadline: Date.now() + 1_800_000,
  effective_policy: {
    version: 1,
    mode: "direct",
    duration: { initial_seconds: 3600, max_seconds: 28_800 },
    agent_network_id: "n1",
    mounts: [],
  },
} as any;

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
});

test("pairs again: the new request first, then the old computer is disconnected; the line is the home bay's", async () => {
  render(<ReconnectComputer computer={m1} />);
  await userEvent.click(screen.getByRole("button", { name: "Pair @m1 again" }));
  await waitFor(() => expect(calls).toEqual(["create", "revoke"]));
  expect(mockApi.createComputerRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "m1",
      policy: expect.objectContaining({
        agent_network_id: "n1",
        duration: { initial_seconds: 3600, max_seconds: 28_800 },
        mounts: [],
      }),
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByText(
        "cocalc computer connect https://bay-2.example.com/c/R-NEW",
      ),
    ).toBeTruthy(),
  );
  expect(document.body.textContent).not.toContain(location.origin);
});

test("if the request can't be made, the old computer is untouched", async () => {
  mockApi.createComputerRequest.mockRejectedValueOnce(
    Error("too many open requests"),
  );
  render(<ReconnectComputer computer={m1} />);
  await userEvent.click(screen.getByRole("button", { name: "Pair @m1 again" }));
  await waitFor(() =>
    expect(document.body.textContent).toContain("Too many open requests."),
  );
  expect(mockApi.revokeComputer).not.toHaveBeenCalled();
});

test("a double click makes one request", async () => {
  let release: () => void = () => {};
  mockApi.createComputerRequest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            request_id: "R-NEW",
            expires_at: Date.now() + 3_600_000,
            pairing_url: "https://bay-2.example.com/c/R-NEW",
          });
      }) as any,
  );
  render(<ReconnectComputer computer={m1} />);
  const button = screen.getByRole("button", { name: "Pair @m1 again" });
  await act(async () => {
    button.click();
    button.click();
  });
  await act(async () => release());
  expect(mockApi.createComputerRequest).toHaveBeenCalledTimes(1);
});
