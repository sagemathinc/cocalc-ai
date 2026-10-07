/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";

import {
  NewAgentCodexPaymentControl,
  newAgentPaymentSourceEnabled,
  shouldDefaultToClaude,
  shouldPrepareProjectForClaude,
} from "./new-agent-codex-payment";

function renderControl(
  props: Partial<Parameters<typeof NewAgentCodexPaymentControl>[0]> = {},
) {
  const onSelect = jest.fn();
  const onSignIn = jest.fn();
  render(
    <NewAgentCodexPaymentControl
      options={[
        { value: "auto", label: "Auto" },
        { value: "account-key", label: "OpenAI API key" },
        { value: "site-api-key", label: "CoCalc Membership", disabled: true },
      ]}
      selectedValue="account-key"
      selectedLabel="OpenAI API key"
      signInAvailable={true}
      unconfigured={false}
      disabled={false}
      loading={false}
      onSelect={onSelect}
      onSignIn={onSignIn}
      {...props}
    />,
  );
  return { onSelect, onSignIn };
}

describe("NewAgentCodexPaymentControl", () => {
  it("offers only ChatGPT sign-in when no payment source works", () => {
    const { onSignIn } = renderControl({ unconfigured: true });
    expect(
      screen.queryByRole("button", { name: /Change payment source/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with ChatGPT" }),
    );
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("offers Claude as an equal alternative when no payment source works", () => {
    const onUseClaude = jest.fn();
    const { onSignIn } = renderControl({ unconfigured: true, onUseClaude });
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with Claude" }),
    );
    expect(onUseClaude).toHaveBeenCalledTimes(1);
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it("offers no Claude sign-in where switching runtimes is not possible", () => {
    renderControl({ unconfigured: true });
    expect(
      screen.queryByRole("button", { name: "Sign in with Claude" }),
    ).toBeNull();
  });

  it("offers no Claude sign-in while a payment source works", () => {
    renderControl({ onUseClaude: jest.fn() });
    expect(
      screen.queryByRole("button", { name: "Sign in with Claude" }),
    ).toBeNull();
  });

  it("disables the sign-in button while the payment source is loading", () => {
    const { onSignIn } = renderControl({
      unconfigured: true,
      loading: true,
      onUseClaude: jest.fn(),
    });
    const button = screen.getByRole("button", { name: "Sign in with ChatGPT" });
    expect(button).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Sign in with Claude" }),
    ).toBeDisabled();
    fireEvent.click(button);
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it("adds a sign-in item to the payment menu when no subscription is connected", async () => {
    const { onSelect, onSignIn } = renderControl();
    fireEvent.click(
      screen.getByRole("button", { name: /Current source: OpenAI API key/ }),
    );
    fireEvent.click(await screen.findByText("Sign in with ChatGPT…"));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects an ordinary payment source from the menu", async () => {
    const { onSelect, onSignIn } = renderControl();
    fireEvent.click(
      screen.getByRole("button", { name: /Current source: OpenAI API key/ }),
    );
    fireEvent.click(await screen.findByText("Auto"));
    expect(onSelect).toHaveBeenCalledWith("auto");
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it("omits the sign-in item once a subscription is connected", async () => {
    renderControl({ signInAvailable: false });
    fireEvent.click(
      screen.getByRole("button", { name: /Current source: OpenAI API key/ }),
    );
    await screen.findByText("Auto");
    expect(screen.queryByText("Sign in with ChatGPT…")).toBeNull();
  });
});

describe("new-agent provider choice without a project", () => {
  it("loads the account's Codex payment status before any project exists", () => {
    expect(
      newAgentPaymentSourceEnabled({ codex: true, projectsLoaded: true }),
    ).toBe(true);
    expect(
      newAgentPaymentSourceEnabled({ codex: true, projectsLoaded: false }),
    ).toBe(false);
    expect(
      newAgentPaymentSourceEnabled({
        codex: true,
        projectId: "p",
        projectsLoaded: false,
      }),
    ).toBe(true);
    expect(
      newAgentPaymentSourceEnabled({
        codex: false,
        projectId: "p",
        projectsLoaded: true,
      }),
    ).toBe(false);
  });

  it("prepares a workspace for Claude only when there is none", () => {
    const base = {
      projectsLoaded: true,
      emailVerificationRequired: false,
      projectPending: false,
    };
    expect(shouldPrepareProjectForClaude(base)).toBe(true);
    expect(shouldPrepareProjectForClaude({ ...base, projectId: "p" })).toBe(
      false,
    );
    expect(
      shouldPrepareProjectForClaude({ ...base, projectsLoaded: false }),
    ).toBe(false);
    expect(
      shouldPrepareProjectForClaude({
        ...base,
        emailVerificationRequired: true,
      }),
    ).toBe(false);
    expect(
      shouldPrepareProjectForClaude({ ...base, projectPending: true }),
    ).toBe(false);
  });

  it("defaults to Claude only for a connected Claude user who cannot pay for Codex", () => {
    const base = {
      firstRun: false,
      codexUnconfigured: true,
      runtimeChosen: false,
      claudeConnected: true,
    };
    expect(shouldDefaultToClaude(base)).toBe(true);
    // The first-run flow prepares a Codex agent in the background.
    expect(shouldDefaultToClaude({ ...base, firstRun: true })).toBe(false);
    expect(shouldDefaultToClaude({ ...base, codexUnconfigured: false })).toBe(
      false,
    );
    expect(shouldDefaultToClaude({ ...base, runtimeChosen: true })).toBe(false);
    expect(shouldDefaultToClaude({ ...base, claudeConnected: false })).toBe(
      false,
    );
  });
});
