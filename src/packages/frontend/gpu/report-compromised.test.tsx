import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompromiseStatus, ReportCompromisedKey } from "./report-compromised";

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

beforeEach(() => {
  mockFreshAuth.mockClear();
  const getComputedStyle = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
});
afterEach(() => jest.restoreAllMocks());

// antd's id helper gives every component the same "test-id" under jest, so
// aria-labelledby can't resolve; check the title inside the dialog instead.
async function findDialog(title: string): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(title)).toBeTruthy();
  return dialog;
}

describe("ReportCompromisedKey", () => {
  it("requires the CoCalc-only confirmation, then reports through fresh auth", async () => {
    const report = jest.fn().mockResolvedValue({
      closed: false,
      managed_pods: 2,
      provider_pods: 3,
      warning: "Delete the key on RunPod's Credentials page now.",
    });
    const onReported = jest.fn();
    const user = userEvent.setup();
    render(<ReportCompromisedKey report={report} onReported={onReported} />);
    await user.click(
      screen.getByRole("button", { name: "My key may be compromised" }),
    );
    const dialog = await findDialog("Report your RunPod key as compromised?");
    expect(
      within(dialog).getByText(/every pod in your RunPod account/),
    ).toBeTruthy();
    const ok = within(dialog).getByRole("button", {
      name: "Terminate everything and stop using the key",
    });
    expect((ok as HTMLButtonElement).disabled).toBe(true);
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: /used only for CoCalc/,
      }),
    );
    expect((ok as HTMLButtonElement).disabled).toBe(false);
    await user.click(ok);
    expect(report).toHaveBeenCalledWith({ confirm_cocalc_only: true });
    expect(mockFreshAuth).toHaveBeenCalledTimes(1);
    // the caller refreshes the key's state (a closed report removes it)
    await waitFor(() =>
      expect(onReported).toHaveBeenCalledWith(
        expect.objectContaining({ managed_pods: 2 }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Delete the key on RunPod's Credentials page now.",
    );
    expect(
      screen.getByText(/2 pods CoCalc started not yet confirmed terminated/),
    ).toBeTruthy();
  });

  it("does nothing when fresh auth is cancelled, and shows errors in the dialog", async () => {
    const report = jest.fn().mockRejectedValueOnce(new Error("hub down"));
    const user = userEvent.setup();
    render(<ReportCompromisedKey report={report} />);
    await user.click(
      screen.getByRole("button", { name: "My key may be compromised" }),
    );
    const dialog = await findDialog("Report your RunPod key as compromised?");
    await user.click(
      within(dialog).getByRole("checkbox", { name: /used only for CoCalc/ }),
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Terminate everything and stop using the key",
      }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "hub down",
    );
    mockFreshAuth.mockImplementationOnce(async () => false);
    await user.click(
      within(dialog).getByRole("button", {
        name: "Terminate everything and stop using the key",
      }),
    );
    // cancelled: the dialog stays open and no status appears
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is keyboard operable: Escape cancels and focus returns to the trigger", async () => {
    const user = userEvent.setup();
    render(<ReportCompromisedKey report={jest.fn()} />);
    const trigger = screen.getByRole("button", {
      name: "My key may be compromised",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("CompromiseStatus", () => {
  it("describes each state in words and always shows the warning", () => {
    const { rerender } = render(<CompromiseStatus status={{ closed: true }} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      /CoCalc removed its copy/,
    );
    rerender(
      <CompromiseStatus
        status={{
          closed: false,
          awaiting_provider_revocation: true,
          warning: "Delete it at RunPod.",
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /RunPod still accepts the key/,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Delete it at RunPod.");
    rerender(
      <CompromiseStatus
        status={{
          closed: false,
          provider_rejected: true,
          listing_failed: true,
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /may still be running/,
    );
    expect(screen.getByText(/couldn.t list the RunPod account/)).toBeTruthy();
  });
});
