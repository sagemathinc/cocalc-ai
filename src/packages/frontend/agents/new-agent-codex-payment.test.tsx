/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";

import { NewAgentCodexPaymentControl } from "./new-agent-codex-payment";

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
    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("disables the sign-in button while the payment source is loading", () => {
    const { onSignIn } = renderControl({ unconfigured: true, loading: true });
    const button = screen.getByRole("button", { name: "Sign in with ChatGPT" });
    expect(button).toBeDisabled();
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
