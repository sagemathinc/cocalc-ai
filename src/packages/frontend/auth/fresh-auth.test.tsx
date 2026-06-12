/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { postAuthApi } from "@cocalc/frontend/auth/api";

import { FreshAuthModal } from "./fresh-auth";

jest.mock("antd", () => {
  const Input: any = ({
    onChange,
    onPressEnter: _onPressEnter,
    ...props
  }: any) => <input {...props} onChange={onChange} />;
  Input.Password = ({
    onChange,
    onPressEnter: _onPressEnter,
    ...props
  }: any) => <input {...props} onChange={onChange} type="password" />;

  return {
    Alert: ({ description, message }: any) => (
      <section>
        {message}
        {description}
      </section>
    ),
    Checkbox: ({ children, checked, disabled, onChange }: any) => (
      <label>
        <input
          checked={checked}
          disabled={disabled}
          onChange={(event: any) => onChange?.(event)}
          type="checkbox"
        />
        {children}
      </label>
    ),
    Input,
    Modal: ({
      children,
      okButtonProps,
      okText,
      onCancel,
      onOk,
      open,
      title,
    }: any) =>
      open ? (
        <section>
          <h1>{title}</h1>
          {children}
          <button onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            disabled={okButtonProps?.disabled}
            onClick={onOk}
            type="button"
          >
            {okText}
          </button>
        </section>
      ) : null,
    Radio: {
      Button: ({ children }: { children?: ReactNode }) => <>{children}</>,
      Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
    },
    Space: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  };
});

jest.mock("@cocalc/frontend/auth/api", () => ({
  postAuthApi: jest.fn(),
}));

jest.mock("@cocalc/frontend/auth/passkeys", () => ({
  freshAuthWithPasskey: jest.fn(),
}));

describe("FreshAuthModal", () => {
  beforeEach(() => {
    jest.mocked(postAuthApi).mockReset();
  });

  it("does not call onCancel after successful verification", async () => {
    jest.mocked(postAuthApi).mockImplementation(async ({ endpoint }: any) => {
      if (endpoint === "auth/fresh-auth-status") {
        return {
          mode: "account",
          enabled: false,
          email_address: "user@example.com",
        };
      }
      if (endpoint === "auth/fresh-auth") {
        return {};
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });
    const onCancel = jest.fn();
    const onSuccess = jest.fn(async () => undefined);

    render(<FreshAuthModal open onCancel={onCancel} onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Verify" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
