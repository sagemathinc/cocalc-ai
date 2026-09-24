/** @jest-environment jsdom */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { ClaudeSubscriptionConnect } from "../claude-subscription-connect";

test("connects a Claude subscription and reports its credential to the caller", async () => {
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
  const submit = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginSubmitCode",
    )
    .mockResolvedValue(undefined as any);
  const onConnected = jest.fn();
  try {
    render(
      <ClaudeSubscriptionConnect
        projectId="project-a"
        onConnected={onConnected}
      />,
    );
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const connect = screen.getByRole("button", {
      name: "Connect Claude Pro/Max (experimental)",
    });
    await user.tab();
    expect(document.activeElement).toBe(connect);
    await act(async () => user.keyboard("{Enter}"));
    expect(start).toHaveBeenCalledWith({ project_id: "project-a" });
    expect(
      screen.getByRole("link", { name: "Open Claude sign-in" }),
    ).toHaveAttribute("href", "https://claude.com/oauth/authorize");
    expect(
      screen.getByRole("textbox", { name: "Claude sign-in code" }),
    ).toBeTruthy();
    await user.type(
      screen.getByRole("textbox", { name: "Claude sign-in code" }),
      "example-code",
    );
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Submit code" }));
    });
    expect(submit).toHaveBeenCalledWith({
      project_id: "project-a",
      id: "login-1",
      code: "example-code",
    });
    await act(async () => {
      jest.advanceTimersByTime(1500);
      await Promise.resolve();
    });
    expect(status).toHaveBeenCalledWith({
      project_id: "project-a",
      id: "login-1",
    });
    expect(onConnected).toHaveBeenCalledWith("credential-1");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Claude subscription connected.",
    );
  } finally {
    start.mockRestore();
    status.mockRestore();
    submit.mockRestore();
    jest.useRealTimers();
  }
});
