/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import CloudflareConfigWizard from "./cloudflare-config-wizard";

jest.mock(
  "./assets/cloudflare-api-token.png",
  () => "cloudflare-api-token.png",
);
jest.mock(
  "./assets/cloudflare-managed-transform-location-headers.png",
  () => "cloudflare-managed-transform-location-headers.png",
);

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }) => <div>{value}</div>,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        system: {
          testR2Credentials: jest.fn(),
        },
      },
    },
  },
}));

describe("CloudflareConfigWizard", () => {
  const originalGetComputedStyle = window.getComputedStyle;
  const baseData = {
    cloudflare_mode: "self",
    dns: "cocalc.example.edu",
    project_hosts_cloudflare_tunnel_account_id:
      "0123456789abcdef0123456789abcdef",
    project_hosts_cloudflare_tunnel_prefix: "cocalc",
    project_hosts_cloudflare_tunnel_host_suffix: "",
    project_hosts_cloudflare_tunnel_api_token: "",
    r2_api_token: "",
    r2_access_key_id: "",
    r2_secret_access_key: "",
    r2_bucket_prefix: "",
  };

  beforeAll(() => {
    jest
      .spyOn(window, "getComputedStyle")
      .mockImplementation((elt: Element) => originalGetComputedStyle(elt));
  });

  afterAll(() => {
    (window.getComputedStyle as jest.Mock).mockRestore();
  });

  it("explains that visitor-header checks use the current running server config", () => {
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={baseData}
        isSet={{ project_hosts_cloudflare_tunnel_api_token: true }}
        onApply={() => {}}
      />,
    );

    expect(
      screen.getByText("Step 8 - Post-save diagnostics"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "These tests use the saved, currently running configuration.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Test Current Visitor Location Headers",
      }),
    ).toBeEnabled();
    expect(
      screen.getAllByText(/cloudflared has successfully set up the tunnel/i)
        .length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("disables the visitor-header check while Cloudflare runtime changes are only in draft", () => {
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={baseData}
        isSet={{ project_hosts_cloudflare_tunnel_api_token: true }}
        onApply={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("cocalc.example.edu"), {
      target: { value: "new.example.edu" },
    });

    expect(
      screen.getByRole("button", {
        name: "Test Current Visitor Location Headers",
      }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "Save and apply Cloudflare tunnel settings before testing visitor headers.",
      ),
    ).toBeInTheDocument();
  });

  it("saves the external domain as the canonical public DNS setting", async () => {
    const onApply = jest.fn(async () => {});
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={baseData}
        isSet={{
          project_hosts_cloudflare_tunnel_api_token: true,
          r2_api_token: true,
          r2_secret_access_key: true,
        }}
        onApply={onApply}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("R2 Access Key ID"), {
      target: { value: "r2-access-key" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply Settings" }));
    });

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        dns: "cocalc.example.edu",
      }),
    );
  });
});
