/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
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
      screen.getByText(
        "Cloudflare tunnel settings are applied at server startup",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Test Current Visitor Location Headers",
      }),
    ).toBeEnabled();
    expect(
      screen.getByText(/does not reflect draft or newly saved/i),
    ).toBeInTheDocument();
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
      screen.getByText(/save them and restart the server/i),
    ).toBeInTheDocument();
  });
});
