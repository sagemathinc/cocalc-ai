/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
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

async function openAndConfirm(
  user: ReturnType<typeof userEvent.setup>,
  uncheck?: string,
) {
  await user.click(screen.getByRole("button", { name: /Delete Account/ }));
  if (uncheck) {
    await user.click(await screen.findByRole("checkbox", { name: uncheck }));
  }
  await user.type(screen.getByPlaceholderText("Full name"), "Ada Lovelace");
  await user.click(
    screen.getByRole("button", { name: "Yes, delete my account" }),
  );
}

function renderButton() {
  const confirm = jest.fn();
  render(
    <IntlProvider locale="en">
      <DeleteAccountButton confirm={confirm} requiredText="Ada Lovelace" />
    </IntlProvider>,
  );
  return confirm;
}

describe("DeleteAccountButton", () => {
  beforeEach(() => mockApi.mockReset());

  it("offers to delete Sagebrush files, checked by default", async () => {
    mockApi.mockResolvedValue({
      clients: [{ client_id: "sagebrush", name: "Sagebrush" }],
    });
    const user = userEvent.setup();
    const confirm = renderButton();
    await user.click(screen.getByRole("button", { name: /Delete Account/ }));
    const checkbox = (await screen.findByRole("checkbox", {
      name: "Also delete my Sagebrush shared files",
    })) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(mockApi).toHaveBeenCalledWith("/accounts/oauth-client-approvals");
    await user.type(screen.getByPlaceholderText("Full name"), "Ada Lovelace");
    await user.click(
      screen.getByRole("button", { name: "Yes, delete my account" }),
    );
    expect(confirm).toHaveBeenCalledWith([]);
  });

  it("passes the site whose files the user keeps", async () => {
    mockApi.mockResolvedValue({
      clients: [{ client_id: "sagebrush", name: "Sagebrush" }],
    });
    const user = userEvent.setup();
    const confirm = renderButton();
    await openAndConfirm(user, "Also delete my Sagebrush shared files");
    expect(confirm).toHaveBeenCalledWith(["sagebrush"]);
  });

  it("shows no option for an account that never used Sagebrush", async () => {
    mockApi.mockResolvedValue({ clients: [] });
    const user = userEvent.setup();
    const confirm = renderButton();
    await openAndConfirm(user);
    await waitFor(() => expect(confirm).toHaveBeenCalledWith([]));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("keeps nothing when the list cannot be loaded", async () => {
    mockApi.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    const confirm = renderButton();
    await openAndConfirm(user);
    expect(confirm).toHaveBeenCalledWith([]);
  });
});
