/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";

const mockApi = jest.fn();
jest.mock("@cocalc/frontend/client/api", () => ({
  __esModule: true,
  default: (...args: any[]) => mockApi(...args),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  React,
  useState: React.useState,
  useTypedRedux: () => undefined,
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  ErrorDisplay: ({ error }) => <div>{`${error}`}</div>,
}));

import { DeleteAccountButton } from "./delete-account";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
});

function renderButton() {
  const confirm = jest.fn();
  render(
    <IntlProvider locale="en">
      <DeleteAccountButton confirm={confirm} requiredText="Ada Lovelace" />
    </IntlProvider>,
  );
  return confirm;
}

async function openAndConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Delete Account/ }));
  await user.type(screen.getByPlaceholderText("Full name"), "Ada Lovelace");
  await user.click(
    screen.getByRole("button", { name: "Yes, delete my account" }),
  );
}

describe("DeleteAccountButton", () => {
  beforeEach(() => mockApi.mockReset());

  it("says that Sagebrush shared files are deleted too, with no option to keep them", async () => {
    mockApi.mockResolvedValue({
      clients: [{ client_id: "sagebrush", name: "Sagebrush" }],
    });
    const user = userEvent.setup();
    const confirm = renderButton();
    await user.click(screen.getByRole("button", { name: /Delete Account/ }));
    expect(
      await screen.findByText(
        "Your files shared on Sagebrush are deleted too.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(mockApi).toHaveBeenCalledWith("/accounts/oauth-client-approvals");
    await user.type(screen.getByPlaceholderText("Full name"), "Ada Lovelace");
    await user.click(
      screen.getByRole("button", { name: "Yes, delete my account" }),
    );
    expect(confirm).toHaveBeenCalled();
  });

  it("does not mention Sagebrush for an account that never used it", async () => {
    mockApi.mockResolvedValue({ clients: [] });
    const user = userEvent.setup();
    const confirm = renderButton();
    await openAndConfirm(user);
    expect(screen.queryByText(/Sagebrush/)).toBeNull();
    expect(confirm).toHaveBeenCalled();
  });

  it("still deletes when the list cannot be loaded", async () => {
    mockApi.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    const confirm = renderButton();
    await openAndConfirm(user);
    expect(confirm).toHaveBeenCalled();
  });
});
