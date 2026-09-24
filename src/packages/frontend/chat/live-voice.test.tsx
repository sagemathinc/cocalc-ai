/** @jest-environment jsdom */
/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatLiveVoice, requestMicrophoneWithTimeout } from "./live-voice";

const mockLiveVoice = jest.fn();
const mockOpenAccountSettings = jest.fn();
jest.mock("@cocalc/frontend/account/settings-routing", () => ({
  openAccountSettings: (...args: any[]) => mockOpenAccountSettings(...args),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        system: { liveVoice: (...args: any[]) => mockLiveVoice(...args) },
      },
    },
  },
}));
jest.mock("@cocalc/chat-client", () => ({
  LiveDelegation: class {},
}));

const props = {
  projectId: "project-1",
  messages: [],
  onDelegate: jest.fn(),
  visible: true,
};

beforeEach(() => {
  mockLiveVoice.mockReset();
  mockOpenAccountSettings.mockReset();
});

it("times out a stalled microphone prompt and stops a late stream", async () => {
  jest.useFakeTimers();
  try {
    let resolveStream!: (stream: MediaStream) => void;
    const request = jest.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve;
        }),
    );
    const pending = requestMicrophoneWithTimeout(request, 25);
    const timedOut = expect(pending).rejects.toThrow(
      /Microphone access timed out/,
    );
    jest.advanceTimersByTime(25);
    await timedOut;
    const stop = jest.fn();
    resolveStream({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it("shows site allowance without a dollar amount and starts from the keyboard", async () => {
  mockLiveVoice.mockResolvedValue({
    enabled: true,
    max_seconds: 120,
    funding_source: "site",
    own_key_available: true,
    allowance: [
      { window: "5h", remaining_percent: 67 },
      { window: "7d", remaining_percent: 42 },
    ],
  });
  const user = userEvent.setup();
  render(<ChatLiveVoice {...props} />);
  const button = await screen.findByRole("button", { name: "Live voice" });
  expect(
    screen.getByLabelText("5-hour limit: 67% remaining"),
  ).toBeInTheDocument();
  expect(
    screen.getByLabelText("7-day limit: 42% remaining"),
  ).toBeInTheDocument();
  expect(screen.getByText("Talk with your agent")).toBeInTheDocument();
  expect(screen.queryByText(/\$|per minute/i)).not.toBeInTheDocument();
  button.focus();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Start live call" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
});

it("offers free users membership or their own key from a dialog", async () => {
  mockLiveVoice.mockImplementation(async ({ funding_preference }) =>
    funding_preference === "own"
      ? { enabled: true, max_seconds: 120, funding_source: "account" }
      : {
          enabled: false,
          max_seconds: 120,
          own_key_available: true,
          reason: "Included live voice requires a paid membership.",
        },
  );
  const user = userEvent.setup();
  render(<ChatLiveVoice {...props} />);
  expect(
    await screen.findByText(/requires a paid membership/),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Live voice" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "View membership plans" }),
  );
  expect(mockOpenAccountSettings).toHaveBeenCalledWith({ page: "membership" });
  await user.click(screen.getByRole("button", { name: "Live voice" }));
  await user.click(screen.getByRole("button", { name: "Use my OpenAI key" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Live voice" }),
    ).toBeInTheDocument(),
  );
  expect(mockLiveVoice).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "capabilities",
      funding_preference: "own",
      project_id: "project-1",
    }),
  );
});

it("sends free users without a key to AI settings", async () => {
  mockLiveVoice.mockResolvedValue({
    enabled: false,
    max_seconds: 120,
    own_key_available: false,
    reason: "Live voice requires a paid membership or your own OpenAI API key.",
  });
  const user = userEvent.setup();
  render(<ChatLiveVoice {...props} />);
  await user.click(await screen.findByRole("button", { name: "Live voice" }));
  await user.click(screen.getByRole("button", { name: "Add an OpenAI key" }));
  expect(mockOpenAccountSettings).toHaveBeenCalledWith({ page: "ai" });
});
