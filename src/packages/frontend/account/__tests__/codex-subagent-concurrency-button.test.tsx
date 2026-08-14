/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodexSubagentConcurrencyButton } from "../codex-subagent-concurrency";

const setOtherSettings = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({ set_other_settings: setOtherSettings }),
  },
  useTypedRedux: () => ({
    get: (key: string) =>
      key === "codex_max_concurrent_subagents" ? 5 : undefined,
  }),
}));

describe("CodexSubagentConcurrencyButton", () => {
  it("opens the account-wide setting and restores focus on Escape", async () => {
    render(<CodexSubagentConcurrencyButton />);

    const button = screen.getByRole("button", {
      name: "Parallel subagents: 5",
    });
    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    const dialog = await screen.findByRole("dialog", {
      name: "Parallel subagents settings",
    });
    expect(
      screen.getByRole("combobox", {
        name: "Maximum concurrent Codex subagents",
      }),
    ).toBeTruthy();
    await waitFor(() => expect(dialog).toHaveFocus());

    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(button).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(button).toHaveFocus());
  });
});
