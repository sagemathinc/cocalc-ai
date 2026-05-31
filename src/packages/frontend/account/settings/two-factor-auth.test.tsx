/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { postAuthApi } from "@cocalc/frontend/auth/api";
import TwoFactorAuthSetting from "./two-factor-auth";

jest.mock("@cocalc/frontend/auth/api", () => ({
  postAuthApi: jest.fn(),
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: ({ open, onSuccess }: any) =>
    open ? (
      <button data-testid="fresh-auth-modal" onClick={onSuccess}>
        Verify fresh auth
      </button>
    ) : null,
}));

jest.mock("@cocalc/frontend/auth/passkeys", () => ({
  registerPasskey: jest.fn(),
}));

jest.mock("@cocalc/frontend/components", () => ({
  SettingBox: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/components/copy-button", () => ({
  __esModule: true,
  default: () => <button>Copy</button>,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: jest.fn(() => undefined),
}));

jest.mock("@cocalc/frontend/control-plane-origin", () => ({
  clearStoredControlPlaneOrigin: jest.fn(),
  getControlPlaneAppUrl: () => undefined,
  getControlPlaneOrigin: () => undefined,
  getStoredControlPlaneOrigin: () => undefined,
  normalizeControlPlaneOrigin: (value: string) => value,
  setStoredControlPlaneOrigin: jest.fn(),
}));

describe("TwoFactorAuthSetting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(postAuthApi).mockImplementation(async ({ endpoint }: any) => {
      if (endpoint === "auth/2fa/status") {
        return { enabled: false, passkeys: [] };
      }
      if (endpoint === "auth/2fa/setup/start") {
        throw new Error("stop after proving setup start was called");
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });
  });

  it("requires fresh auth before starting authenticator app setup", async () => {
    render(<TwoFactorAuthSetting />);

    const startButton = await screen.findByRole("button", {
      name: "Set up authenticator app",
    });
    expect(postAuthApi).not.toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "auth/2fa/setup/start" }),
    );

    fireEvent.click(startButton);

    expect(screen.getByTestId("fresh-auth-modal")).toBeInTheDocument();
    expect(postAuthApi).not.toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "auth/2fa/setup/start" }),
    );

    fireEvent.click(screen.getByTestId("fresh-auth-modal"));

    await waitFor(() => {
      expect(postAuthApi).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: "auth/2fa/setup/start" }),
      );
    });
  });

  it("requires fresh auth before renaming a passkey", async () => {
    jest.mocked(postAuthApi).mockImplementation(async ({ endpoint }: any) => {
      if (endpoint === "auth/2fa/status") {
        return {
          enabled: true,
          passkeys: [
            {
              id: "factor-1",
              label: "Old passkey",
              credential_id: "credential-1",
            },
          ],
        };
      }
      if (endpoint === "auth/2fa/passkeys/rename") {
        return {
          passkey: {
            id: "factor-1",
            label: "New passkey",
            credential_id: "credential-1",
          },
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    render(<TwoFactorAuthSetting />);

    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByDisplayValue("Old passkey"), {
      target: { value: "New passkey" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByTestId("fresh-auth-modal")).toBeInTheDocument();
    expect(postAuthApi).not.toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "auth/2fa/passkeys/rename" }),
    );

    fireEvent.click(screen.getByTestId("fresh-auth-modal"));

    await waitFor(() => {
      expect(postAuthApi).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "auth/2fa/passkeys/rename",
          body: { factor_id: "factor-1", label: "New passkey" },
        }),
      );
    });
  });
});
