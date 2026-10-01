import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigProvider, theme } from "antd";

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UsernameSetting } from "./username-setting";
import {
  dispatchUsernameChanged,
  USERNAME_CHANGED_EVENT,
} from "../username-events";
import type { UsernameChangedDetail } from "../username-events";
import type { AccountUsername } from "@cocalc/conat/hub/api/personal-urls";
import { usePersonalUrlOwner } from "@cocalc/frontend/personal-url-owner";
import { onPersonalUrlOwnerChange } from "@cocalc/frontend/personal-url-state";

jest.mock("@cocalc/frontend/webapp-client", () => {
  const { EventEmitter } = jest.requireActual("events");
  return {
    webapp_client: Object.assign(new EventEmitter(), {
      conat_client: {
        is_signed_in: () => true,
        hub: {
          personalUrls: { getUsername: jest.fn(), setUsername: jest.fn() },
        },
      },
    }),
  };
});

const originalClient = webapp_client.conat_client;
const api = jest.mocked(webapp_client.conat_client.hub.personalUrls);
const account_id = "00000000-0000-4000-8000-000000000001";
const initial = { account_id, username: null, redirects: [] as string[] };

beforeEach(() => {
  jest.resetAllMocks();
  webapp_client.conat_client = originalClient;
  webapp_client.account_id = account_id;
  originalClient.signedInMessage = { account_id, hub: "test" };
  api.getUsername.mockResolvedValue(initial);
});

function switchAccount(nextAccountId: string) {
  webapp_client.account_id = nextAccountId;
  originalClient.signedInMessage = { account_id: nextAccountId, hub: "test" };
  webapp_client.emit("signed_in", originalClient.signedInMessage);
}

it.each(["light", "dark"])(
  "offers an optional username and UUID fallback in the %s theme",
  async (mode) => {
    render(
      <ConfigProvider
        theme={{
          algorithm:
            mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        }}
      >
        <UsernameSetting />
      </ConfigProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Username (optional)" });
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue("");
    expect(input).toHaveAccessibleDescription(
      /UUID link works without a username/,
    );
    expect(screen.getAllByText(`/u/${account_id}`)).toHaveLength(2);
    expect(api.getUsername).toHaveBeenCalledWith({});
    expect(
      screen.getByRole("button", { name: "Save username" }),
    ).toBeDisabled();
    expect(api.setUsername).not.toHaveBeenCalled();
  },
);

it("saves from the keyboard, displays the server-normalized name, and restores focus", async () => {
  const user = userEvent.setup();
  api.setUsername.mockResolvedValue({ ...initial, username: "ada" });
  render(<UsernameSetting />);
  const input = screen.getByRole("textbox", { name: "Username (optional)" });
  await waitFor(() => expect(input).toBeEnabled());
  await user.tab();
  expect(input).toHaveFocus();
  await user.keyboard(" Ada {Enter}");
  await waitFor(() =>
    expect(api.setUsername).toHaveBeenCalledWith({ username: "Ada" }),
  );
  await waitFor(() => expect(input).toHaveValue("ada"));
  expect(input).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent("Username saved");
  expect(screen.getByText("/u/ada")).toBeInTheDocument();
});

it("renames without losing reserved redirects", async () => {
  const user = userEvent.setup();
  api.getUsername.mockResolvedValue({
    ...initial,
    username: "ada",
    redirects: ["older"],
  });
  api.setUsername.mockResolvedValue({
    ...initial,
    username: "new-ada",
    redirects: ["older", "ada"],
  });
  render(<UsernameSetting />);
  const input = screen.getByRole("textbox", { name: "Username (optional)" });
  await waitFor(() => expect(input).toHaveValue("ada"));
  await user.clear(input);
  await user.type(input, "new-ada{Enter}");
  await waitFor(() => expect(input).toHaveValue("new-ada"));
  expect(screen.getByText("/u/older")).toBeInTheDocument();
  expect(screen.getByText("/u/ada")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /release/i }),
  ).not.toBeInTheDocument();
});

it("clears to null while keeping the old name reserved", async () => {
  const user = userEvent.setup();
  api.getUsername.mockResolvedValue({ ...initial, username: "ada" });
  api.setUsername.mockResolvedValue({ ...initial, redirects: ["ada"] });
  render(<UsernameSetting />);
  const input = screen.getByRole("textbox", { name: "Username (optional)" });
  await waitFor(() => expect(input).toHaveValue("ada"));
  await user.clear(input);
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(api.setUsername).toHaveBeenCalledWith({ username: null }),
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Username removed"),
  );
  expect(screen.getByText("/u/ada")).toBeInTheDocument();
  expect(screen.getAllByText(`/u/${account_id}`)).toHaveLength(2);
  expect(input).toHaveFocus();
});

it("resets an unsaved change using the keyboard without a mutation", async () => {
  const user = userEvent.setup();
  api.getUsername.mockResolvedValue({ ...initial, username: "ada" });
  render(<UsernameSetting />);
  const input = screen.getByRole("textbox", { name: "Username (optional)" });
  await waitFor(() => expect(input).toHaveValue("ada"));
  await user.tab();
  await user.keyboard("-unsaved");
  await user.tab();
  await user.tab();
  expect(screen.getByRole("button", { name: "Reset username" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(input).toHaveValue("ada");
  expect(input).toHaveFocus();
  expect(api.setUsername).not.toHaveBeenCalled();
});

it("announces a save error, preserves the draft, and focuses its described input", async () => {
  const user = userEvent.setup();
  api.setUsername.mockRejectedValueOnce(new Error("Username is reserved"));
  api.setUsername.mockResolvedValueOnce({ ...initial, username: "available" });
  render(<UsernameSetting />);
  const input = screen.getByRole("textbox", { name: "Username (optional)" });
  await waitFor(() => expect(input).toBeEnabled());
  await user.tab();
  await user.keyboard("reserved{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Username is reserved",
  );
  expect(input).toHaveValue("reserved");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAccessibleDescription(/Username is reserved/);
  expect(input).toHaveFocus();
  await user.clear(input);
  await user.keyboard("available{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Username saved"),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("retries a load error by keyboard without enabling edits before loading", async () => {
  const user = userEvent.setup();
  api.getUsername.mockRejectedValueOnce(new Error("Service unavailable"));
  render(<UsernameSetting />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Service unavailable",
  );
  const input = screen.getByRole("textbox", { name: "Username (optional)" });
  expect(input).toBeDisabled();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Retry loading username" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(input).toBeEnabled());
  expect(input).toHaveFocus();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("locks edits and prevents duplicate requests while saving", async () => {
  const user = userEvent.setup();
  let finish!: (value: typeof initial) => void;
  api.getUsername.mockResolvedValue({ ...initial, username: "ada" });
  api.setUsername.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<UsernameSetting />);
  const input = screen.getByRole("textbox", { name: "Username (optional)" });
  await waitFor(() => expect(input).toHaveValue("ada"));
  await user.clear(input);
  await user.keyboard("{Enter}{Enter}");
  expect(input).toBeDisabled();
  expect(screen.getByRole("button", { name: /Save username/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Reset username" })).toBeDisabled();
  expect(api.setUsername).toHaveBeenCalledTimes(1);
  await act(async () => finish(initial));
  expect(input).toBeEnabled();
  expect(input).toHaveFocus();
});

it("reloads for the actual signed-in account while mounted and ignores its predecessor's load", async () => {
  let finish!: (value: AccountUsername) => void;
  api.getUsername.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<UsernameSetting />);
  api.getUsername.mockResolvedValue({
    ...initial,
    account_id: "other-account",
    username: "other",
  });
  act(() => switchAccount("other-account"));
  const input = screen.getByRole("textbox", { name: "Username (optional)" });
  await waitFor(() => expect(input).toHaveValue("other"));
  await act(async () => finish({ ...initial, username: "stale" }));
  expect(input).toHaveValue("other");
  expect(screen.queryByText(`/u/${account_id}`)).not.toBeInTheDocument();
  expect(api.getUsername).toHaveBeenCalledTimes(2);
});

it("reloads when the client is replaced for the same account and ignores the old client", async () => {
  let fail!: (error: Error) => void;
  api.getUsername.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      fail = reject;
    }),
  );
  const replacementGet = jest
    .fn()
    .mockResolvedValue({ ...initial, username: "replacement" });
  render(<UsernameSetting />);
  act(() => {
    webapp_client.conat_client = {
      ...originalClient,
      hub: {
        ...originalClient.hub,
        personalUrls: { ...api, getUsername: replacementGet },
      },
    };
    webapp_client.emit("connected");
  });
  const input = screen.getByRole("textbox", { name: "Username (optional)" });
  await waitFor(() => expect(input).toHaveValue("replacement"));
  await act(async () => fail(new Error("Stale connection failed")));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(input).toHaveValue("replacement");
});

it.each(["account", "client", "signed-out"])(
  "checks live %s identity before saving, even before React processes an auth event",
  async (change) => {
    const user = userEvent.setup();
    render(<UsernameSetting />);
    const input = screen.getByRole("textbox", { name: "Username (optional)" });
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "draft");
    if (change === "client") webapp_client.conat_client = { ...originalClient };
    else
      webapp_client.account_id =
        change === "account" ? "other-account" : undefined;
    fireEvent.submit(input.closest("form")!);
    expect(api.setUsername).not.toHaveBeenCalled();
  },
);

it.each([
  ["success", "account"],
  ["failure", "account"],
  ["success", "client"],
  ["failure", "client"],
])(
  "ignores a late save %s after switching %s, including messages, focus and refresh events",
  async (outcome, change) => {
    const user = userEvent.setup();
    let finish!: (value: AccountUsername) => void;
    let fail!: (error: Error) => void;
    const changed = jest.fn();
    window.addEventListener(USERNAME_CHANGED_EVENT, changed);
    try {
      api.setUsername.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
      );
      render(<UsernameSetting />);
      const oldInput = screen.getByRole("textbox", {
        name: "Username (optional)",
      });
      await waitFor(() => expect(oldInput).toBeEnabled());
      await user.type(oldInput, "old-draft{Enter}");
      api.getUsername.mockResolvedValue({
        ...initial,
        account_id: change === "account" ? "other-account" : account_id,
        username: "other",
      });
      act(() => {
        if (change === "account") switchAccount("other-account");
        else {
          webapp_client.conat_client = { ...originalClient };
          webapp_client.emit("connected");
        }
      });
      const input = screen.getByRole("textbox", {
        name: "Username (optional)",
      });
      await waitFor(() => expect(input).toHaveValue("other"));
      await user.type(input, "-draft");
      await user.tab();
      const save = screen.getByRole("button", { name: "Save username" });
      expect(save).toHaveFocus();
      await act(async () => {
        if (outcome === "success")
          finish({ ...initial, username: "old-draft" });
        else fail(new Error("Stale save failed"));
      });
      expect(input).toHaveValue("other-draft");
      expect(input).toBeEnabled();
      expect(save).toHaveFocus();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).not.toHaveTextContent(
        "Username saved",
      );
      expect(changed).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(USERNAME_CHANGED_EVENT, changed);
    }
  },
);

it("invalidates pending work across sign-out/sign-in to the same account and clears its draft", async () => {
  const user = userEvent.setup();
  let finish!: (value: AccountUsername) => void;
  api.setUsername.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<UsernameSetting />);
  const oldInput = screen.getByRole("textbox", { name: "Username (optional)" });
  await waitFor(() => expect(oldInput).toBeEnabled());
  await user.type(oldInput, "old-draft{Enter}");
  act(() => {
    webapp_client.account_id = undefined;
    webapp_client.emit("signed_out");
  });
  expect(
    screen.getByRole("textbox", { name: "Username (optional)" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("textbox", { name: "Username (optional)" }),
  ).toHaveValue("");
  expect(api.getUsername).toHaveBeenCalledTimes(1);
  act(() => switchAccount(account_id));
  const input = screen.getByRole("textbox", { name: "Username (optional)" });
  await waitFor(() => expect(input).toBeEnabled());
  await act(async () => finish({ ...initial, username: "old-draft" }));
  expect(input).toHaveValue("");
  expect(screen.getByRole("status")).not.toHaveTextContent("Username saved");
});

it("rejects a username load response for another account", async () => {
  api.getUsername.mockResolvedValue({
    ...initial,
    account_id: "unexpected-account",
    username: "not-yours",
  });
  render(<UsernameSetting />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "different account",
  );
  expect(
    screen.getByRole("textbox", { name: "Username (optional)" }),
  ).toBeDisabled();
  expect(screen.queryByText("/u/not-yours")).not.toBeInTheDocument();
});

it.each(["normalized", null])(
  "publishes an account-scoped owner refresh only after saving %s",
  async (username) => {
    const user = userEvent.setup();
    const events: UsernameChangedDetail[] = [];
    const onChange = (event: Event) =>
      events.push((event as CustomEvent<UsernameChangedDetail>).detail);
    window.addEventListener(USERNAME_CHANGED_EVENT, onChange);
    try {
      api.getUsername.mockResolvedValue({ ...initial, username: "before" });
      api.setUsername.mockResolvedValue({ ...initial, username });
      render(<UsernameSetting />);
      const input = screen.getByRole("textbox", {
        name: "Username (optional)",
      });
      await waitFor(() => expect(input).toHaveValue("before"));
      expect(events).toEqual([]);
      await user.clear(input);
      if (username != null) await user.type(input, "Normalized");
      await user.keyboard("{Enter}");
      await waitFor(() => expect(events).toEqual([{ account_id, username }]));
    } finally {
      window.removeEventListener(USERNAME_CHANGED_EVENT, onChange);
    }
  },
);

it("preserves unsaved edits during a same-account reconnect", async () => {
  const user = userEvent.setup();
  render(<UsernameSetting />);
  const input = screen.getByRole("textbox", { name: "Username (optional)" });
  await waitFor(() => expect(input).toBeEnabled());
  await user.type(input, "draft");
  act(() => {
    webapp_client.emit("connected");
    switchAccount(account_id);
  });
  expect(input).toHaveValue("draft");
  expect(api.getUsername).toHaveBeenCalledTimes(1);
});

it("delivers each username change to the owner subscriber exactly once", () => {
  const changed = jest.fn();
  const unsubscribe = onPersonalUrlOwnerChange(changed);
  try {
    dispatchUsernameChanged({ account_id, username: "ada" });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(account_id);
  } finally {
    unsubscribe();
  }
});

it("refreshes only the saved account's mounted owner hook", async () => {
  function OwnerPreview({ owner }: { owner: string }) {
    const prefix = usePersonalUrlOwner(owner);
    return <output aria-label={owner}>{prefix}</output>;
  }
  const user = userEvent.setup();
  let current: AccountUsername = { ...initial, username: "before" };
  api.getUsername.mockImplementation(async (opts = {}) =>
    opts.owner_account_id === "other-account"
      ? { ...initial, account_id: "other-account", username: "other" }
      : current,
  );
  api.setUsername.mockImplementation(async ({ username }) => {
    current = { ...current, username };
    return current;
  });
  render(
    <>
      <UsernameSetting />
      <OwnerPreview owner={account_id} />
      <OwnerPreview owner="other-account" />
    </>,
  );
  const preview = screen.getByRole("status", { name: account_id });
  await waitFor(() => expect(preview).toHaveTextContent("before"));
  const input = screen.getByRole("textbox", { name: "Username (optional)" });
  await user.clear(input);
  await user.type(input, "after{Enter}");
  await waitFor(() => expect(preview).toHaveTextContent("after"));
  expect(
    screen.getByRole("status", { name: "other-account" }),
  ).toHaveTextContent("other");
  expect(
    api.getUsername.mock.calls.filter(
      ([opts]) => opts?.owner_account_id === "other-account",
    ),
  ).toHaveLength(1);
});
