import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KEY_RPC_TIMEOUT_MS } from "@cocalc/util/gpu/provider-keys";
import { CHECKING_POLL_MS, GpuProviderKeySection } from "./gpu-provider-key";

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
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "00000000-1000-4000-8000-000000000001",
}));
jest.mock("@cocalc/frontend/gpu/runpod-dashboard-section", () => ({
  RunpodAlertsSection: ({ account_id }) => (
    <div>GPU alerts for {account_id}</div>
  ),
  RunpodDashboardSection: ({ account_id, onKeyChanged }) => (
    <div>
      GPU dashboard for {account_id}
      <button onClick={onKeyChanged}>Report a key change</button>
    </div>
  ),
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
        timeout: 90_000,
      }),
    );
    expect(mockFreshAuth).toHaveBeenCalled();
    expect(mockSystem.getGpuProviderKeyStatus).toHaveBeenCalledWith({
      provider: "runpod",
      timeout: KEY_RPC_TIMEOUT_MS,
    });
    const connected = await screen.findByRole("status");
    expect(connected.textContent).toMatch(/Connected to RunPod account user_1/);
    // The Connect button is gone; focus moved to the announced status.
    await waitFor(() => expect(document.activeElement).toBe(connected));
    expect(screen.queryByDisplayValue(KEY)).toBeNull();
  });

  it("keeps the key field out of password managers, masked until shown", async () => {
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue(DISCONNECTED);
    render(<GpuProviderKeySection />);
    const input = (await screen.findByLabelText(
      "RunPod API key",
    )) as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.hasAttribute("data-1p-ignore")).toBe(true);
    expect(input.getAttribute("data-lpignore")).toBe("true");
    expect(input.getAttribute("data-bwignore")).toBe("true");
    // (jsdom drops -webkit-text-security, so only the toggle is checked)
    await userEvent.click(screen.getByLabelText("Show key"));
    expect(screen.getByLabelText("Hide key")).toBeTruthy();
  });

  it("says the RunPod account is still being checked until the first inventory", async () => {
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue({
      ...CONNECTED,
      inventory: "checking",
    });
    render(<GpuProviderKeySection />);
    expect(
      await screen.findByText(/Checking your RunPod account/),
    ).toBeTruthy();
  });

  it("looks again while the RunPod account is being checked, and stops once it's done", async () => {
    jest.useFakeTimers({ advanceTimers: true });
    try {
      mockSystem.getGpuProviderKeyStatus
        .mockResolvedValueOnce({ ...CONNECTED, inventory: "checking" })
        .mockResolvedValue({ ...CONNECTED, inventory: "complete" });
      render(<GpuProviderKeySection />);
      expect(
        await screen.findByText(/Checking your RunPod account/),
      ).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(CHECKING_POLL_MS);
      });
      await waitFor(() =>
        expect(screen.queryByText(/Checking your RunPod account/)).toBeNull(),
      );
      expect(mockSystem.getGpuProviderKeyStatus).toHaveBeenCalledTimes(2);
      await act(async () => {
        jest.advanceTimersByTime(3 * CHECKING_POLL_MS);
      });
      expect(mockSystem.getGpuProviderKeyStatus).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("says nothing about checking once the inventory is complete", async () => {
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue({
      ...CONNECTED,
      inventory: "complete",
    });
    render(<GpuProviderKeySection />);
    await screen.findByRole("status");
    expect(screen.queryByText(/Checking your RunPod account/)).toBeNull();
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
        // a first removal never forces (only "Remove anyway" does)
        force: false,
        // longer than a removal forwarded to another bay may take
        timeout: KEY_RPC_TIMEOUT_MS,
      }),
    );
    expect(await screen.findByLabelText("RunPod API key")).toBeTruthy();
  });

  it("while pods drain, offers to remove again or anyway; anyway forces and warns about the pods left", async () => {
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue(CONNECTED);
    mockSystem.deleteGpuProviderKey
      .mockResolvedValueOnce({ revoked: false, remaining: ["cc-7f3k9q2x"] })
      .mockResolvedValueOnce({
        revoked: true,
        unmanaged: ["cc-7f3k9q2x"],
        warning: "1 pod launched with this key may still be running",
      });
    render(<GpuProviderKeySection />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove" }),
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "Remove" }).at(-1)!,
    );
    expect(
      await screen.findByText(/Terminating 1 GPU pod launched with this key/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove again" })).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove anyway" }),
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "Remove anyway" }).at(-1)!,
    );
    await waitFor(() =>
      expect(mockSystem.deleteGpuProviderKey).toHaveBeenLastCalledWith(
        expect.objectContaining({ provider: "runpod", force: true }),
      ),
    );
    expect(await screen.findByText(/may still be running/)).toBeTruthy();
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

  it("keeps the Remove confirmation keyboard-operable, and never removes while a save runs", async () => {
    const user = userEvent.setup();
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue(CONNECTED);
    let finish!: (status: any) => void;
    mockSystem.setGpuProviderKey.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    render(<GpuProviderKeySection />);
    const replace = await screen.findByRole("button", { name: "Replace key" });
    replace.focus();
    await user.keyboard("{Enter}");
    const remove = screen.getByRole("button", { name: "Remove" });
    // Keyboard into the confirmation, and Escape back out to Remove.
    remove.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("tooltip");
    expect(within(dialog).getByText(/Remove your RunPod key\?/)).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(document.activeElement).toBe(remove);
    // Overlay first: open it again, then (no click outside) Tab on to the
    // key field and save with Enter.
    await user.keyboard("{Enter}");
    await screen.findByRole("tooltip");
    const input = screen.getByLabelText("RunPod API key");
    while (document.activeElement !== input) await user.tab();
    await user.keyboard(`${KEY}{Enter}`);
    await waitFor(() =>
      expect(mockSystem.setGpuProviderKey).toHaveBeenCalled(),
    );
    // The confirmation closed when the save started, and Remove is disabled
    // until it finishes.
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    expect(mockSystem.deleteGpuProviderKey).not.toHaveBeenCalled();
    finish(CONNECTED);
    await waitFor(() =>
      expect((remove as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("reloads the real status after a failed removal, e.g. a lost reply", async () => {
    const user = userEvent.setup();
    mockSystem.getGpuProviderKeyStatus
      .mockResolvedValueOnce(CONNECTED)
      .mockResolvedValue(DISCONNECTED);
    mockSystem.deleteGpuProviderKey.mockRejectedValue(new Error("timeout"));
    render(<GpuProviderKeySection />);
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await user.click(
      within(await screen.findByRole("tooltip")).getByRole("button", {
        name: "Remove",
      }),
    );
    // It was in fact removed: the panel shows that, with the error.
    expect(await screen.findByLabelText("RunPod API key")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(mockSystem.getGpuProviderKeyStatus).toHaveBeenCalledTimes(2);
  });

  it("after a removal, announces it and moves focus there", async () => {
    const user = userEvent.setup();
    mockSystem.getGpuProviderKeyStatus
      .mockResolvedValueOnce(CONNECTED)
      .mockResolvedValue(DISCONNECTED);
    mockSystem.deleteGpuProviderKey.mockResolvedValue({ revoked: true });
    render(<GpuProviderKeySection />);
    const remove = await screen.findByRole("button", { name: "Remove" });
    remove.focus();
    await user.keyboard("{Enter}");
    await user.click(
      within(await screen.findByRole("tooltip")).getByRole("button", {
        name: "Remove",
      }),
    );
    const notice = await screen.findByText(/key was removed from CoCalc/);
    expect(notice.getAttribute("role")).toBe("status");
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  it("shows a stored key as inactive after the membership lapses, with Remove only", async () => {
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue({
      ...CONNECTED,
      entitled: false,
    });
    render(<GpuProviderKeySection />);
    expect(
      await screen.findByText(/no longer includes RunPod GPUs/),
    ).toBeTruthy();
    expect(screen.getByText(/Inactive key for RunPod/)).toBeTruthy();
    expect(screen.queryByText(/^Connected to RunPod/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace key" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("shows the GPU dashboard only while a key is connected", async () => {
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue(CONNECTED);
    const { unmount } = render(<GpuProviderKeySection />);
    expect(
      await screen.findByText(
        "GPU dashboard for 00000000-1000-4000-8000-000000000001",
      ),
    ).toBeTruthy();
    unmount();
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue(DISCONNECTED);
    render(<GpuProviderKeySection />);
    await screen.findByLabelText("RunPod API key");
    expect(screen.queryByText(/GPU dashboard/)).toBeNull();
  });

  it("re-reads the key's status when the dashboard reports a change (e.g. a closed compromise)", async () => {
    mockSystem.getGpuProviderKeyStatus.mockResolvedValueOnce(CONNECTED);
    mockSystem.getGpuProviderKeyStatus.mockResolvedValueOnce(DISCONNECTED);
    render(<GpuProviderKeySection />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Report a key change" }),
    );
    // CoCalc's copy is gone: the key form is back, the dashboard is gone
    expect(await screen.findByLabelText("RunPod API key")).toBeTruthy();
    expect(screen.queryByText(/GPU dashboard/)).toBeNull();
    expect(mockSystem.getGpuProviderKeyStatus).toHaveBeenCalledTimes(2);
  });

  it("shows the GPU alerts without a key, e.g. pods a forced removal left running", async () => {
    mockSystem.getGpuProviderKeyStatus.mockResolvedValue(DISCONNECTED);
    render(<GpuProviderKeySection />);
    await screen.findByLabelText("RunPod API key");
    expect(
      screen.getByText("GPU alerts for 00000000-1000-4000-8000-000000000001"),
    ).toBeTruthy();
    expect(screen.queryByText(/GPU dashboard/)).toBeNull();
  });
});
