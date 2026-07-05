/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import CloudflareConfigWizard from "./cloudflare-config-wizard";
import { webapp_client } from "@cocalc/frontend/webapp-client";

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

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        system: {
          testR2Credentials: jest.fn(),
          testCloudflareVisitorLocationHeaders: jest.fn(),
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("explains that diagnostics use saved settings", () => {
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
      screen.getByText("Diagnostics use saved settings."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Test Public Domain Location Headers",
      }),
    ).toBeEnabled();
    expect(
      screen.getByText(
        "R2 checks the saved backup credentials. Public domain headers checks the saved external domain through Cloudflare.",
      ),
    ).toBeInTheDocument();
  });

  it("disables apply when there are no draft changes", () => {
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={{
          ...baseData,
          r2_access_key_id: "r2-access-key",
          r2_bucket_prefix: "cocalc",
        }}
        isSet={{
          project_hosts_cloudflare_tunnel_api_token: true,
          r2_api_token: true,
          r2_secret_access_key: true,
        }}
        onApply={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Apply Settings" }),
    ).toBeDisabled();
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
        name: "Test Public Domain Location Headers",
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
    const onClose = jest.fn();
    render(
      <CloudflareConfigWizard
        open
        onClose={onClose}
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
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Settings applied and saved. You can now run diagnostics.",
      ),
    ).toBeInTheDocument();
  });

  it("tests visitor location headers through the saved public domain diagnostic", async () => {
    const testLocationHeaders = webapp_client.conat_client.hub.system
      .testCloudflareVisitorLocationHeaders as jest.Mock;
    testLocationHeaders.mockResolvedValue({
      ok: true,
      url: "https://cocalc.example.edu/customize",
      missing: [],
      details: {
        country: "US",
        region: "California",
        regionCode: "CA",
        city: "San Francisco",
        continent: "NA",
        timezone: "America/Los_Angeles",
        latitude: "37.7749",
        longitude: "-122.4194",
      },
    });
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={baseData}
        isSet={{ project_hosts_cloudflare_tunnel_api_token: true }}
        onApply={() => {}}
      />,
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Test Public Domain Location Headers",
        }),
      );
    });

    expect(testLocationHeaders).toHaveBeenCalledWith({});
    expect(
      screen.getByText("Public domain location headers are present"),
    ).toBeInTheDocument();
    expect(document.body).toHaveTextContent(
      "https://cocalc.example.edu/customize",
    );
  });
});
