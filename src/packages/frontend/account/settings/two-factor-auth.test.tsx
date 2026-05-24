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

jest.mock("@cocalc/frontend/antd-bootstrap", () => ({
  Button: ({ children, bsStyle: _bsStyle, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
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
});
