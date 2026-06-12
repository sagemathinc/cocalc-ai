/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useState } from "react";

import { postAuthApi } from "@cocalc/frontend/auth/api";

import { FreshAuthModal, useFreshAuthAction } from "./fresh-auth";

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

function FreshAuthActionHarness({ action }: { action: () => Promise<void> }) {
  const [callerError, setCallerError] = useState("");
  const { freshAuthActionRunning, runFreshAuthAction, freshAuthModalProps } =
    useFreshAuthAction({
      onUnhandledError: (err) => setCallerError(`Caller handled ${err}`),
    });

  return (
    <>
      <button
        onClick={async () => {
          try {
            await runFreshAuthAction(action);
          } catch (err) {
            setCallerError(`Initial caller handled ${err}`);
          }
        }}
        type="button"
      >
        Run protected action
      </button>
      {freshAuthActionRunning ? <div>Retrying protected action</div> : null}
      {callerError ? <div>{callerError}</div> : undefined}
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}

describe("useFreshAuthAction", () => {
  beforeEach(() => {
    jest.mocked(postAuthApi).mockReset();
  });

  it("closes the auth modal before routing retry failures to the caller", async () => {
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
    const freshAuthError: any = new Error("fresh auth is required");
    freshAuthError.code = "fresh_auth_required";
    const retryError = new Error("payment retry failed");
    let rejectRetry: (err: Error) => void = () => undefined;
    const retryPromise = new Promise<void>((_, reject) => {
      rejectRetry = reject;
    });
    const action = jest.fn(async () => {
      if (action.mock.calls.length === 1) {
        throw freshAuthError;
      }
      await retryPromise;
    });

    render(<FreshAuthActionHarness action={action} />);

    fireEvent.click(screen.getByText("Run protected action"));

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Verify" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => {
      expect(screen.getByText("Retrying protected action")).toBeTruthy();
    });
    await waitFor(() => {
      expect(action).toHaveBeenCalledTimes(2);
    });
    rejectRetry(retryError);
    await waitFor(() => {
      expect(
        screen.getByText("Caller handled Error: payment retry failed"),
      ).toBeTruthy();
    });
    expect(
      screen.queryByRole("heading", { name: "Confirm security action" }),
    ).toBeNull();
  });
});
