import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigProvider, theme } from "antd";

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { AdminPersonalUrls } from "./personal-urls";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  ...jest.requireActual("@cocalc/frontend/auth/fresh-auth"),
  FreshAuthModal: ({ open, onCancel, onSuccess }) =>
    open ? (
      <section aria-label="Security verification">
        <button onClick={onCancel}>Cancel verification</button>
        <button onClick={onSuccess}>Verify security action</button>
      </section>
    ) : null,
}));

jest.mock("@cocalc/frontend/webapp-client", () => {
  const { EventEmitter } = jest.requireActual("events");
  return {
    webapp_client: Object.assign(new EventEmitter(), {
      conat_client: {
        is_signed_in: () => true,
        hub: {
          personalUrls: { getUsername: jest.fn(), releaseRedirect: jest.fn() },
        },
      },
    }),
  };
});

const originalClient = webapp_client.conat_client;
const api = jest.mocked(webapp_client.conat_client.hub.personalUrls);
const account_id = "00000000-0000-4000-8000-000000000001";
const initial = {
  account_id,
  username: "ada",
  redirects: ["old-ada", "older-ada"],
};

beforeAll(() => {
  const getComputedStyle = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  webapp_client.conat_client = originalClient;
  webapp_client.account_id = "admin-account";
  originalClient.signedInMessage = { account_id: "admin-account", hub: "test" };
  api.getUsername.mockReset().mockResolvedValue(initial);
  api.releaseRedirect.mockReset().mockResolvedValue(undefined);
});

function switchActor() {
  webapp_client.account_id = "other-admin";
  originalClient.signedInMessage = { account_id: "other-admin", hub: "test" };
  webapp_client.emit("signed_in", originalClient.signedInMessage);
}

async function openRelease(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole("button", {
    name: "Release redirect /u/old-ada",
  });
  await user.tab();
  expect(trigger).toHaveFocus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "Release redirect /u/old-ada?",
  });
  await waitFor(() =>
    expect(
      within(dialog).getByRole("textbox", {
        name: "Reason for release (required)",
      }),
    ).toHaveFocus(),
  );
  return { trigger, dialog };
}

async function confirmRelease(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) {
  await user.keyboard("  Support request  ");
  await user.tab();
  expect(
    within(dialog).getByRole("textbox", {
      name: "Type old-ada to confirm release",
    }),
  ).toHaveFocus();
  await user.keyboard("old-ada");
  await user.tab();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  await user.tab();
  expect(
    within(dialog).getByRole("button", { name: /Release redirect/ }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
}

it.each(["light", "dark"])(
  "lists names but never offers release of the current name in %s mode",
  async (mode) => {
    api.getUsername.mockResolvedValue({
      ...initial,
      redirects: ["ada", "old-ada"],
    });
    render(
      <ConfigProvider
        theme={{
          algorithm:
            mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        }}
      >
        <AdminPersonalUrls account_id={account_id} />
      </ConfigProvider>,
    );
    expect(
      await screen.findByText("ada", { selector: "code" }),
    ).toBeInTheDocument();
    expect(api.getUsername).toHaveBeenCalledWith({
      owner_account_id: account_id,
    });
    expect(screen.getByText(`/u/${account_id}`)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Release redirect /u/old-ada" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Release redirect /u/ada" }),
    ).not.toBeInTheDocument();
  },
);

it("requires a nonblank reason and an exact typed confirmation", async () => {
  const user = userEvent.setup();
  render(<AdminPersonalUrls account_id={account_id} />);
  const { dialog } = await openRelease(user);
  expect(
    within(dialog).getByText(/Old URLs may identify a new owner after reuse/),
  ).toBeInTheDocument();
  const release = within(dialog).getByRole("button", {
    name: "Release redirect",
  });
  expect(release).toBeDisabled();
  await user.keyboard("   ");
  await user.tab();
  await user.keyboard("old-ada");
  expect(release).toBeDisabled();
  await user.tab({ shift: true });
  await user.keyboard("Support request");
  expect(release).toBeEnabled();
  await user.tab();
  await user.keyboard("wrong");
  expect(release).toBeDisabled();
  expect(api.releaseRedirect).not.toHaveBeenCalled();
});

it("cancels with Escape and restores focus to the exact redirect button", async () => {
  const user = userEvent.setup();
  render(<AdminPersonalUrls account_id={account_id} />);
  const { trigger } = await openRelease(user);
  await user.keyboard("unsaved reason{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
  expect(api.releaseRedirect).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  const reason = await screen.findByRole("textbox", {
    name: "Reason for release (required)",
  });
  expect(reason).toHaveValue("");
});

it("releases by keyboard, refreshes the server state, and focuses the heading when the trigger disappears", async () => {
  const user = userEvent.setup();
  render(<AdminPersonalUrls account_id={account_id} />);
  const { dialog } = await openRelease(user);
  api.getUsername.mockResolvedValue({ ...initial, redirects: ["older-ada"] });
  await confirmRelease(user, dialog);
  await waitFor(() =>
    expect(api.releaseRedirect).toHaveBeenCalledWith({
      owner_account_id: account_id,
      username: "old-ada",
      reason: "Support request",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Released redirect /u/old-ada",
  );
  expect(screen.getByRole("heading", { name: "Personal URLs" })).toHaveFocus();
  expect(
    screen.queryByRole("button", { name: "Release redirect /u/old-ada" }),
  ).not.toBeInTheDocument();
  expect(api.getUsername).toHaveBeenCalledTimes(2);
});

it("keeps a failed release open, focuses the error, and preserves the inputs", async () => {
  const user = userEvent.setup();
  api.releaseRedirect.mockRejectedValueOnce(
    new Error("This is now the current username"),
  );
  render(<AdminPersonalUrls account_id={account_id} />);
  const { dialog } = await openRelease(user);
  await confirmRelease(user, dialog);
  const error = await within(dialog).findByText(
    /This is now the current username/,
  );
  expect(error.closest('[role="alert"]')?.parentElement).toHaveFocus();
  expect(
    within(dialog).getByRole("textbox", {
      name: "Reason for release (required)",
    }),
  ).toHaveValue("  Support request  ");
  expect(
    within(dialog).getByRole("textbox", {
      name: "Type old-ada to confirm release",
    }),
  ).toHaveValue("old-ada");
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: "Release redirect /u/old-ada" }),
  ).toHaveFocus();
});

it("uses the fresh-auth wrapper to retry exactly the confirmed request", async () => {
  const user = userEvent.setup();
  api.releaseRedirect.mockRejectedValueOnce({ code: "fresh_auth_required" });
  render(<AdminPersonalUrls account_id={account_id} />);
  const { dialog } = await openRelease(user);
  await confirmRelease(user, dialog);
  const verify = await screen.findByRole("button", {
    name: "Verify security action",
  });
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(
    within(dialog).getByRole("textbox", {
      name: "Reason for release (required)",
    }),
  ).toBeDisabled();
  expect(api.releaseRedirect).toHaveBeenCalledTimes(1);
  api.getUsername.mockResolvedValue({ ...initial, redirects: ["older-ada"] });
  await user.click(verify);
  await waitFor(() => expect(api.releaseRedirect).toHaveBeenCalledTimes(2));
  expect(api.releaseRedirect.mock.calls[1]).toEqual(
    api.releaseRedirect.mock.calls[0],
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("does not report success or retry when fresh authentication is cancelled", async () => {
  const user = userEvent.setup();
  api.releaseRedirect.mockRejectedValueOnce({ code: "fresh_auth_required" });
  render(<AdminPersonalUrls account_id={account_id} />);
  const { dialog } = await openRelease(user);
  await confirmRelease(user, dialog);
  await user.click(
    await screen.findByRole("button", { name: "Cancel verification" }),
  );
  const reason = within(dialog).getByRole("textbox", {
    name: "Reason for release (required)",
  });
  await waitFor(() => expect(reason).toHaveFocus());
  expect(api.releaseRedirect).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).not.toHaveTextContent("Released");
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
});

it("locks the confirmation during a pending release and prevents duplicate submission", async () => {
  const user = userEvent.setup();
  let finish!: () => void;
  api.releaseRedirect.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<AdminPersonalUrls account_id={account_id} />);
  const { dialog } = await openRelease(user);
  await confirmRelease(user, dialog);
  await user.keyboard("{Enter}{Escape}");
  expect(dialog).toBeInTheDocument();
  expect(api.releaseRedirect).toHaveBeenCalledTimes(1);
  expect(
    within(dialog).getByRole("button", { name: /Release redirect/ }),
  ).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  await act(async () => finish());
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("handles load failure without treating it as an account with no redirects", async () => {
  const user = userEvent.setup();
  api.getUsername.mockRejectedValueOnce(new Error("Load failed"));
  render(<AdminPersonalUrls account_id={account_id} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Load failed");
  expect(screen.queryByText("No reserved redirects.")).not.toBeInTheDocument();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Refresh personal URLs" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Release redirect /u/old-ada" });
  expect(
    screen.getByRole("button", { name: "Refresh personal URLs" }),
  ).toHaveFocus();
});

it("keeps a successful release successful even if refreshing fails", async () => {
  const user = userEvent.setup();
  render(<AdminPersonalUrls account_id={account_id} />);
  const { dialog } = await openRelease(user);
  api.getUsername.mockRejectedValueOnce(new Error("Refresh failed"));
  await confirmRelease(user, dialog);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Released redirect /u/old-ada",
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Refresh failed");
  expect(
    screen.queryByRole("button", { name: "Release redirect /u/old-ada" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Release redirect /u/older-ada" }),
  ).toBeDisabled();
  expect(api.releaseRedirect).toHaveBeenCalledTimes(1);
});

it("discards an old owner's late response when the account changes", async () => {
  let finish!: (info: typeof initial) => void;
  api.getUsername.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { rerender } = render(<AdminPersonalUrls account_id={account_id} />);
  api.getUsername.mockResolvedValue({
    account_id: "other-account",
    username: null,
    redirects: [],
  });
  rerender(<AdminPersonalUrls account_id="other-account" />);
  await screen.findByText("No reserved redirects.");
  await act(async () => finish(initial));
  expect(
    screen.queryByRole("button", { name: /Release redirect/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("/u/other-account")).toBeInTheDocument();
});

it("resets a mounted confirmation and reloads its target when the acting account changes", async () => {
  const user = userEvent.setup();
  render(<AdminPersonalUrls account_id={account_id} />);
  await openRelease(user);
  await user.keyboard("Old actor's reason");
  act(switchActor);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(api.getUsername).toHaveBeenCalledTimes(2));
  expect(api.releaseRedirect).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Release redirect /u/old-ada" }),
  );
  expect(
    screen.getByRole("textbox", { name: "Reason for release (required)" }),
  ).toHaveValue("");
});

it.each(["account", "client"])(
  "checks the live %s before the first release request",
  async (change) => {
    const user = userEvent.setup();
    render(<AdminPersonalUrls account_id={account_id} />);
    const { dialog } = await openRelease(user);
    await user.keyboard("Reason");
    await user.tab();
    await user.keyboard("old-ada");
    if (change === "account") webapp_client.account_id = "other-admin";
    else webapp_client.conat_client = { ...originalClient };
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Release redirect" }),
    );
    expect(api.releaseRedirect).not.toHaveBeenCalled();
  },
);

it.each(["account", "client"])(
  "does not retry fresh auth through a changed %s",
  async (change) => {
    const user = userEvent.setup();
    api.releaseRedirect.mockRejectedValueOnce({ code: "fresh_auth_required" });
    render(<AdminPersonalUrls account_id={account_id} />);
    const { dialog } = await openRelease(user);
    await confirmRelease(user, dialog);
    const verify = await screen.findByRole("button", {
      name: "Verify security action",
    });
    const replacementRelease = jest.fn();
    if (change === "account") webapp_client.account_id = "other-admin";
    else
      webapp_client.conat_client = {
        ...originalClient,
        hub: {
          ...originalClient.hub,
          personalUrls: { ...api, releaseRedirect: replacementRelease },
        },
      };
    await user.click(verify);
    expect(api.releaseRedirect).toHaveBeenCalledTimes(1);
    expect(replacementRelease).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).not.toHaveTextContent("Released");
  },
);

it.each([
  ["success", "account"],
  ["failure", "account"],
  ["fresh-auth", "account"],
  ["success", "client"],
  ["failure", "client"],
  ["fresh-auth", "client"],
])(
  "ignores late release %s after the acting %s switches",
  async (outcome, change) => {
    const user = userEvent.setup();
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    api.releaseRedirect.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
    );
    render(<AdminPersonalUrls account_id={account_id} />);
    const { dialog } = await openRelease(user);
    await confirmRelease(user, dialog);
    act(() => {
      if (change === "account") switchActor();
      else {
        webapp_client.conat_client = { ...originalClient };
        webapp_client.emit("connected");
      }
    });
    const refresh = screen.getByRole("button", {
      name: "Refresh personal URLs",
    });
    await waitFor(() => expect(refresh).toBeEnabled());
    act(() => refresh.focus());
    await act(async () => {
      if (outcome === "success") finish();
      else
        fail(
          outcome === "fresh-auth"
            ? { code: "fresh_auth_required" }
            : new Error("Old release failed"),
        );
    });
    expect(api.getUsername).toHaveBeenCalledTimes(2);
    expect(api.releaseRedirect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).not.toHaveTextContent("Released");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Verify security action" }),
    ).not.toBeInTheDocument();
    expect(refresh).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Release redirect /u/old-ada" }),
    ).toBeInTheDocument();
  },
);
