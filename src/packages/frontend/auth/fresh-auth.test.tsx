/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useState } from "react";

import { postAuthApi } from "@cocalc/frontend/auth/api";
import { getControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";

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
      zIndex,
    }: any) =>
      open ? (
        <section data-testid="antd-modal" data-z-index={zIndex}>
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

jest.mock("@cocalc/frontend/control-plane-origin", () => ({
  getControlPlaneOrigin: jest.fn(),
}));

jest.mock("@cocalc/frontend/auth/passkeys", () => ({
  freshAuthWithPasskey: jest.fn(),
}));

function enterCurrentPassword() {
  fireEvent.change(screen.getByPlaceholderText("Enter your current password"), {
    target: { value: "current-password" },
  });
}

describe("FreshAuthModal", () => {
  beforeEach(() => {
    jest.mocked(postAuthApi).mockReset();
    jest.mocked(getControlPlaneOrigin).mockReset();
    jest.mocked(getControlPlaneOrigin).mockReturnValue(undefined);
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
        screen.getByPlaceholderText("Enter your current password"),
      ).toBeTruthy();
    });
    enterCurrentPassword();
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

  it("uses the control-plane origin for fresh-auth calls by default", async () => {
    jest
      .mocked(getControlPlaneOrigin)
      .mockReturnValue("https://bay-2-lite.example.com");
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

    render(
      <FreshAuthModal
        open
        onCancel={jest.fn()}
        onSuccess={jest.fn(async () => undefined)}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Enter your current password"),
      ).toBeTruthy();
    });
    enterCurrentPassword();
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Verify" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => {
      expect(postAuthApi).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "auth/fresh-auth",
          origin: "https://bay-2-lite.example.com",
        }),
      );
    });
    expect(postAuthApi).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "auth/fresh-auth-status",
        origin: "https://bay-2-lite.example.com",
      }),
    );
  });

  it("renders above ordinary confirmation modals", async () => {
    jest
      .mocked(postAuthApi)
      .mockReturnValue(new Promise(() => undefined) as any);

    render(
      <FreshAuthModal
        open
        onCancel={jest.fn()}
        onSuccess={jest.fn(async () => undefined)}
      />,
    );

    expect(screen.getByTestId("antd-modal").dataset.zIndex).toBe("3000");
  });
});

function FreshAuthActionHarness({ action }: { action: () => Promise<void> }) {
  const [callerError, setCallerError] = useState("");
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  return (
    <>
      <button
        onClick={async () => {
          try {
            setRunning(true);
            const result = await runFreshAuthAction(action);
            setCompleted(result);
          } catch (err) {
            setCallerError(`Initial caller handled ${err}`);
          } finally {
            setRunning(false);
          }
        }}
        type="button"
      >
        Run protected action
      </button>
      {running ? <div>Protected action running</div> : null}
      {completed ? <div>Protected action completed</div> : null}
      {callerError ? <div>{callerError}</div> : undefined}
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}

describe("useFreshAuthAction", () => {
  beforeEach(() => {
    jest.mocked(postAuthApi).mockReset();
    jest.mocked(getControlPlaneOrigin).mockReset();
    jest.mocked(getControlPlaneOrigin).mockReturnValue(undefined);
  });

  it("keeps the action promise pending through fresh auth and retry failure", async () => {
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

    expect(screen.getByText("Protected action running")).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Enter your current password"),
      ).toBeTruthy();
    });
    enterCurrentPassword();
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Verify" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => {
      expect(screen.getByText("Protected action running")).toBeTruthy();
    });
    await waitFor(() => {
      expect(action).toHaveBeenCalledTimes(2);
    });
    rejectRetry(retryError);
    await waitFor(() => {
      expect(
        screen.getByText("Initial caller handled Error: payment retry failed"),
      ).toBeTruthy();
    });
    expect(screen.queryByText("Protected action running")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Confirm security action" }),
    ).toBeNull();
  });

  it("resolves false when fresh auth is canceled", async () => {
    jest.mocked(postAuthApi).mockImplementation(async ({ endpoint }: any) => {
      if (endpoint === "auth/fresh-auth-status") {
        return {
          mode: "account",
          enabled: false,
          email_address: "user@example.com",
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });
    const freshAuthError: any = new Error("fresh auth is required");
    freshAuthError.code = "fresh_auth_required";
    const action = jest.fn(async () => {
      throw freshAuthError;
    });

    render(<FreshAuthActionHarness action={action} />);

    fireEvent.click(screen.getByText("Run protected action"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByText("Protected action running")).toBeNull();
    });
    expect(screen.queryByText("Protected action completed")).toBeNull();
    expect(action).toHaveBeenCalledTimes(1);
  });
});
