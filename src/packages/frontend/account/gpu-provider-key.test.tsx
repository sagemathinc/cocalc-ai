import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
        // longer than the server's worst-case verification
        timeout: 45_000,
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

  it("disables Remove while a replacement key is being verified", async () => {
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue(CONNECTED);
    let finish!: (status: any) => void;
    mockSystem.setGpuProviderKey.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    render(<GpuProviderKeySection />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Replace key" }),
    );
    await userEvent.type(screen.getByLabelText("RunPod API key"), KEY);
    await userEvent.click(
      screen.getAllByRole("button", { name: /Replace key/ }).at(-1)!,
    );
    await waitFor(() =>
      expect(mockSystem.setGpuProviderKey).toHaveBeenCalled(),
    );
    expect(
      (screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    finish(CONNECTED);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it("reloads the real status after a failed save, e.g. a timeout", async () => {
    mockSystem.getGpuProviderKeyStatus
      .mockResolvedValueOnce(DISCONNECTED)
      .mockResolvedValue(CONNECTED);
    mockSystem.setGpuProviderKey.mockRejectedValue(new Error("timeout"));
    render(<GpuProviderKeySection />);
    await userEvent.type(await screen.findByLabelText("RunPod API key"), KEY);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(
      await screen.findByText(/Connected to RunPod account user_1/),
    ).toBeTruthy();
    expect(mockSystem.getGpuProviderKeyStatus).toHaveBeenCalledTimes(2);
  });

  it("never removes from a confirmation left open while a save starts", async () => {
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue(CONNECTED);
    let finish!: (status: any) => void;
    mockSystem.setGpuProviderKey.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    render(<GpuProviderKeySection />);
    fireEvent.click(await screen.findByRole("button", { name: "Replace key" }));
    // Overlay first: the removal confirmation is open...
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const title = await screen.findByText(/Remove your RunPod key\?/);
    const confirm = within(title.closest(".ant-popover") as HTMLElement);
    // ...then, without any click outside it, Enter in the key field saves.
    const input = screen.getByLabelText("RunPod API key");
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
    await waitFor(() =>
      expect(mockSystem.setGpuProviderKey).toHaveBeenCalled(),
    );
    // The stale dialog is hidden, and confirming it anyway does nothing.
    expect(title.closest(".ant-popover")?.className).toMatch(/hidden/);
    fireEvent.click(
      confirm.getByRole("button", { name: "Remove", hidden: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockSystem.deleteGpuProviderKey).not.toHaveBeenCalled();
    finish(CONNECTED);
    await waitFor(() =>
      expect(
        (
          screen.getAllByRole("button", {
            name: "Remove",
          })[0] as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });
});
