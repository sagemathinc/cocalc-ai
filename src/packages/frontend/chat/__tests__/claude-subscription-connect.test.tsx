/** @jest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { ClaudeSubscriptionConnect } from "../claude-subscription-connect";

beforeEach(() => {
  jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginCancel",
    )
    .mockResolvedValue(undefined as any);
});

test("an existing connection labels sign-in as optional and remains keyboard accessible", async () => {
  render(
    <ClaudeSubscriptionConnect
      projectId="project-a"
      hasConnection
      onConnected={jest.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", {
      name: "Connect another Claude subscription",
    }),
  );
  expect(
    screen.queryByRole("button", {
      name: "Connect Claude Pro/Max",
    }),
  ).toBeNull();
});

test.each([false, true])(
  "connects a Claude subscription (reconnect=%s) and reports its credential to the caller",
  async (reconnect) => {
    jest.useFakeTimers();
    const start = jest
      .spyOn(
        webapp_client.conat_client.hub.projects,
        "claudeSubscriptionLoginStart",
      )
      .mockResolvedValue({
        id: "login-1",
        state: "pending",
        verificationUrl: "https://claude.com/oauth/authorize",
      } as any);
    const status = jest
      .spyOn(
        webapp_client.conat_client.hub.projects,
        "claudeSubscriptionLoginStatus",
      )
      .mockResolvedValue({
        id: "login-1",
        state: "completed",
        credentialId: "credential-1",
      } as any);
    let resolveSubmit!: () => void;
    const submit = jest
      .spyOn(
        webapp_client.conat_client.hub.projects,
        "claudeSubscriptionLoginSubmitCode",
      )
      .mockImplementation(
        () =>
          new Promise<any>((resolve) => {
            resolveSubmit = () => resolve(undefined);
          }),
      );
    const rename = jest
      .spyOn(
        webapp_client.conat_client.hub.system,
        "updateClaudeSubscriptionLabel",
      )
      .mockResolvedValue({ updated: true } as any);
    const onConnected = jest.fn();
    try {
      render(
        <ClaudeSubscriptionConnect
          projectId="project-a"
          reconnectCredentialId={reconnect ? "credential-1" : undefined}
          hasConnection={reconnect}
          onConnected={onConnected}
        />,
      );
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      const connect = screen.getByRole("button", {
        name: reconnect ? "Reconnect Claude" : "Connect Claude Pro/Max",
      });
      await user.tab();
      expect(document.activeElement).toBe(connect);
      await act(async () => user.keyboard("{Enter}"));
      expect(start).toHaveBeenCalledWith({
        project_id: "project-a",
        ...(reconnect ? { credential_id: "credential-1" } : {}),
      });
      // A new subscription is named while connecting; a reconnect keeps its name.
      // Labelled by the visible step title.
      const nameField = screen.queryByRole("textbox", {
        name: "Name this subscription",
      });
      if (reconnect) {
        expect(nameField).toBeNull();
      } else {
        await user.type(nameField!, "Max 20x (work)");
      }
      expect(
        screen.getByRole("link", { name: "Open Claude sign-in" }),
      ).toHaveAttribute("href", "https://claude.com/oauth/authorize");
      expect(
        screen.getByRole("textbox", { name: "Claude sign-in code" }),
      ).toBeTruthy();
      // The trigger buttons step aside while signing in.
      expect(
        screen.queryByRole("button", {
          name: reconnect ? "Reconnect Claude" : "Connect Claude Pro/Max",
        }),
      ).toBeNull();
      const connectButton = screen.getByRole("button", { name: "Connect" });
      expect(connectButton).toBeDisabled();
      await user.type(
        screen.getByRole("textbox", { name: "Claude sign-in code" }),
        "examplecode#examplestate",
      );
      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Connect" }));
      });
      expect(submit).toHaveBeenCalledWith({
        project_id: "project-a",
        id: "login-1",
        code: "examplecode#examplestate",
      });
      expect(screen.getByRole("status")).toHaveTextContent(
        "Connecting to Claude",
      );
      expect(
        screen.queryByRole("textbox", { name: "Claude sign-in code" }),
      ).toBeNull();
      await act(async () => resolveSubmit());
      expect(screen.getByRole("status")).toHaveTextContent(
        "Connecting to Claude",
      );
      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });
      expect(status).toHaveBeenCalledWith({
        project_id: "project-a",
        id: "login-1",
      });
      await waitFor(() =>
        expect(onConnected).toHaveBeenCalledWith("credential-1"),
      );
      if (reconnect) {
        expect(rename).not.toHaveBeenCalled();
      } else {
        expect(rename).toHaveBeenCalledWith({
          id: "credential-1",
          label: "Max 20x (work)",
        });
        // Named before the caller hears about it, so it shows the name.
        expect(rename.mock.invocationCallOrder[0]).toBeLessThan(
          onConnected.mock.invocationCallOrder[0],
        );
      }
      expect(screen.getByRole("status")).toHaveTextContent(
        "Claude subscription connected.",
      );
      if (!reconnect) {
        // Connecting another subscription starts with a blank name.
        await act(async () =>
          user.click(
            screen.getByRole("button", { name: "Connect Claude Pro/Max" }),
          ),
        );
        expect(
          screen.getByRole("textbox", { name: "Name this subscription" }),
        ).toHaveValue("");
      }
    } finally {
      rename.mockRestore();
      start.mockRestore();
      status.mockRestore();
      submit.mockRestore();
      jest.useRealTimers();
    }
  },
);

test("a failed code submission keeps the code and allows correction", async () => {
  const start = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStart",
    )
    .mockResolvedValue({
      id: "login-failed",
      state: "pending",
      verificationUrl: "https://claude.com/oauth/authorize",
    } as any);
  const submit = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginSubmitCode",
    )
    .mockRejectedValue(Error("Unable to submit code"));
  try {
    render(
      <ClaudeSubscriptionConnect
        projectId="project-a"
        onConnected={jest.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: "Connect Claude Pro/Max",
      }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Claude sign-in code" }),
      "examplecode#examplestate",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to submit code",
    );
    expect(
      screen.getByRole("textbox", { name: "Claude sign-in code" }),
    ).toHaveValue("examplecode#examplestate");
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    start.mockRestore();
    submit.mockRestore();
  }
});

test("focused sign-in opens with Enter and Escape cancels and restores focus", async () => {
  const start = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStart",
    )
    .mockResolvedValue({
      id: "modal-login",
      state: "pending",
      verificationUrl: "https://claude.com/oauth/authorize",
    } as any);
  const cancel = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginCancel",
    )
    .mockResolvedValue(undefined as any);
  try {
    render(
      <ClaudeSubscriptionConnect
        modal
        projectId="project-a"
        onConnected={jest.fn()}
      />,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", {
      name: "Connect Claude Pro/Max",
    });
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", {
      name: "Connect Claude Pro/Max",
    });
    await waitFor(() =>
      expect(dialog).toContainElement(document.activeElement as HTMLElement),
    );
    expect(
      screen.getByRole("link", { name: "Open Claude sign-in" }),
    ).toHaveAttribute("target", "_blank");
    expect(
      screen.getByRole("textbox", { name: "Claude sign-in code" }),
    ).toHaveAttribute(
      "placeholder",
      "Paste the code Claude shows after you sign in",
    );
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cancel).toHaveBeenCalledWith({
      project_id: "project-a",
      id: "modal-login",
    });
    expect(button).toHaveFocus();
  } finally {
    start.mockRestore();
    cancel.mockRestore();
  }
});

test("closing while sign-in starts cancels its eventual session without reopening the dialog", async () => {
  let finish!: (value: any) => void;
  const start = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStart",
    )
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const cancel = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginCancel",
    )
    .mockResolvedValue(undefined as any);
  try {
    render(
      <ClaudeSubscriptionConnect
        modal
        projectId="project-a"
        onConnected={jest.fn()}
      />,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", {
      name: "Connect Claude Pro/Max",
    });
    await user.click(button);
    expect(
      screen.getByRole("button", { name: /Preparing sign-in/ }),
    ).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () =>
      finish({
        id: "late-login",
        state: "pending",
        verificationUrl: "https://claude.com/oauth/authorize",
      }),
    );
    expect(cancel).toHaveBeenCalledWith({
      project_id: "project-a",
      id: "late-login",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button).toBeEnabled();
  } finally {
    start.mockRestore();
    cancel.mockRestore();
  }
});

test("a modal start failure offers an explicit retry", async () => {
  const start = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStart",
    )
    .mockRejectedValueOnce(Error("Service unavailable"))
    .mockResolvedValue({
      id: "retry-login",
      state: "pending",
      verificationUrl: "https://claude.com/oauth/authorize",
    } as any);
  try {
    render(
      <ClaudeSubscriptionConnect
        modal
        projectId="project-a"
        onConnected={jest.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Connect Claude Pro/Max" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Service unavailable");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(start).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("link", { name: "Open Claude sign-in" }),
    ).toBeTruthy();
  } finally {
    start.mockRestore();
  }
});

test("unmount cancels an active sign-in so navigation does not block the next attempt", async () => {
  const start = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStart",
    )
    .mockResolvedValue({
      id: "abandoned-login",
      state: "pending",
      verificationUrl: "https://claude.com/oauth/authorize",
    } as any);
  try {
    const { unmount } = render(
      <ClaudeSubscriptionConnect
        modal
        projectId="project-a"
        onConnected={jest.fn()}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Connect Claude Pro/Max" }));
    unmount();
    expect(
      webapp_client.conat_client.hub.projects.claudeSubscriptionLoginCancel,
    ).toHaveBeenCalledWith({
      project_id: "project-a",
      id: "abandoned-login",
    });
  } finally {
    start.mockRestore();
  }
});

test("pasting a complete code connects at once; a partial code gets a hint", async () => {
  const start = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStart",
    )
    .mockResolvedValue({
      id: "paste-login",
      state: "pending",
      verificationUrl: "https://claude.com/oauth/authorize",
    } as any);
  const submit = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginSubmitCode",
    )
    .mockResolvedValue(undefined as any);
  try {
    render(
      <ClaudeSubscriptionConnect
        projectId="project-a"
        onConnected={jest.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Connect Claude Pro/Max" }),
    );
    const box = screen.getByRole("textbox", { name: "Claude sign-in code" });
    await user.click(box);
    await user.paste("onlyhalfofthecode");
    expect(screen.getByText(/does not look like the whole code/)).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
    await user.clear(box);
    await user.paste("  qooDIvd1gVrO7RWAgK5#qazX7djX16S5sYo8  ");
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        project_id: "project-a",
        id: "paste-login",
        code: "qooDIvd1gVrO7RWAgK5#qazX7djX16S5sYo8",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Connecting to Claude",
    );
  } finally {
    start.mockRestore();
    submit.mockRestore();
  }
});

test("a sign-in request waits until enabled, then starts once", async () => {
  const start = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStart",
    )
    .mockResolvedValue({
      id: "requested-login",
      state: "pending",
      verificationUrl: "https://claude.com/oauth/authorize",
    } as any);
  const handled = jest.fn();
  try {
    const { rerender } = render(
      <ClaudeSubscriptionConnect
        modal
        disabled
        openRequested
        onOpenRequestHandled={handled}
        projectId="project-a"
        onConnected={jest.fn()}
      />,
    );
    expect(handled).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    rerender(
      <ClaudeSubscriptionConnect
        modal
        openRequested
        onOpenRequestHandled={handled}
        projectId="project-a"
        onConnected={jest.fn()}
      />,
    );
    expect(
      await screen.findByRole("link", { name: "Open Claude sign-in" }),
    ).toBeTruthy();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    start.mockRestore();
  }
});

test("canceling while the name is saved does not report the connection", async () => {
  jest.useFakeTimers();
  const start = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStart",
    )
    .mockResolvedValue({
      id: "login-2",
      state: "pending",
      verificationUrl: "https://claude.com/oauth/authorize",
    } as any);
  const status = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStatus",
    )
    .mockResolvedValue({
      id: "login-2",
      state: "completed",
      credentialId: "credential-2",
    } as any);
  const cancelLogin = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginCancel",
    )
    .mockResolvedValue(undefined as any);
  let finishRename!: () => void;
  const rename = jest
    .spyOn(
      webapp_client.conat_client.hub.system,
      "updateClaudeSubscriptionLabel",
    )
    .mockImplementation(
      () =>
        new Promise<any>((resolve) => {
          finishRename = () => resolve({ updated: true });
        }),
    );
  const onConnected = jest.fn();
  try {
    render(
      <ClaudeSubscriptionConnect
        projectId="project-a"
        onConnected={onConnected}
      />,
    );
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await act(async () =>
      user.click(
        screen.getByRole("button", { name: "Connect Claude Pro/Max" }),
      ),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Name this subscription" }),
      "Work",
    );
    await act(async () => {
      jest.advanceTimersByTime(1500);
      await Promise.resolve();
    });
    await waitFor(() => expect(rename).toHaveBeenCalled());
    await act(async () =>
      user.click(screen.getByRole("button", { name: "Cancel" })),
    );
    await act(async () => finishRename());
    expect(onConnected).not.toHaveBeenCalled();
  } finally {
    rename.mockRestore();
    cancelLogin.mockRestore();
    start.mockRestore();
    status.mockRestore();
    jest.useRealTimers();
  }
});
