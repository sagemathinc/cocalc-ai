import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GpuProviderKeySection } from "./gpu-provider-key";

const mockSystem = {
  getGpuProviderKeyStatus: jest.fn(),
  setGpuProviderKey: jest.fn(),
  deleteGpuProviderKey: jest.fn(),
};
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-1",
    conat_client: {
      get hub() {
        return { system: mockSystem };
      },
    },
  },
}));
const mockFreshAuth = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: (action) => mockFreshAuth(action),
    freshAuthModalProps: {},
  }),
}));
jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: () => <span>just now</span>,
}));

const KEY = "rpa_SYNTHETICKEY0123456789abcdefghijklmnopqrstuv";
const DISCONNECTED = { provider: "runpod", entitled: true, connected: false };
const CONNECTED = {
  provider: "runpod",
  entitled: true,
  connected: true,
  provider_account: { kind: "personal", id: "user_1" },
  connected_at: "2026-10-27T20:00:00.000Z",
};

beforeEach(() => {
  for (const f of Object.values(mockSystem)) f.mockReset();
  mockFreshAuth.mockClear();
});

describe("GpuProviderKeySection", () => {
  it("connects a pasted key through fresh auth, then shows the RunPod account", async () => {
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue(DISCONNECTED);
    mockSystem.setGpuProviderKey.mockResolvedValue(CONNECTED);
    render(<GpuProviderKeySection />);
    const input = await screen.findByLabelText("RunPod API key");
    await userEvent.type(input, KEY);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(mockSystem.setGpuProviderKey).toHaveBeenCalledWith({
        provider: "runpod",
        api_key: KEY,
        browser_id: "browser-1",
      }),
    );
    expect(mockFreshAuth).toHaveBeenCalled();
    expect(
      await screen.findByText(/Connected to RunPod account user_1/),
    ).toBeTruthy();
    expect(screen.queryByDisplayValue(KEY)).toBeNull();
  });

  it("tells members without the feature where to get it, with no key form", async () => {
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue({
      ...DISCONNECTED,
      entitled: false,
    });
    render(<GpuProviderKeySection />);
    expect(await screen.findByText(/doesn't include RunPod GPUs/)).toBeTruthy();
    expect(screen.queryByLabelText("RunPod API key")).toBeNull();
  });

  it("says to also delete the key at RunPod before removing it", async () => {
    mockSystem.getGpuProviderKeyStatus
      .mockResolvedValueOnce(CONNECTED)
      .mockResolvedValue(DISCONNECTED);
    mockSystem.deleteGpuProviderKey.mockResolvedValue({ revoked: true });
    render(<GpuProviderKeySection />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove" }),
    );
    expect(
      await screen.findByText(/also delete it on RunPod's Credentials page/),
    ).toBeTruthy();
    await userEvent.click(
      screen.getAllByRole("button", { name: "Remove" }).at(-1)!,
    );
    await waitFor(() =>
      expect(mockSystem.deleteGpuProviderKey).toHaveBeenCalledWith({
        provider: "runpod",
        browser_id: "browser-1",
      }),
    );
    expect(await screen.findByLabelText("RunPod API key")).toBeTruthy();
  });

  it("shows a server error, such as a rejected key", async () => {
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue(DISCONNECTED);
    mockSystem.setGpuProviderKey.mockRejectedValue(
      new Error("RunPod rejected this API key. Check that it is correct."),
    );
    render(<GpuProviderKeySection />);
    await userEvent.type(await screen.findByLabelText("RunPod API key"), KEY);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/RunPod rejected this API key/)).toBeTruthy();
  });
});
