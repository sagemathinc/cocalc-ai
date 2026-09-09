/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CloudflareConfigWizard from "./cloudflare-config-wizard";
import { bootstrapTokenEndDate } from "./cloudflare-bootstrap";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  ...jest.requireActual("@cocalc/frontend/auth/fresh-auth"),
  FreshAuthModal: ({ open, onCancel, onSuccess }) =>
    open ? (
      <section aria-label="Security verification">
        <button onClick={onCancel}>Cancel verification</button>
        <button onClick={onSuccess}>Verify security action</button>
      </section>
    ) : null,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "wizard-browser-session",
    conat_client: {
      callHubApi: jest.fn(),
      hub: {
        system: {
          testR2Credentials: jest.fn(),
          bootstrapCloudflareConfiguration: jest.fn(),
          reconcileCloudflareBlobs: jest.fn(),
          applyCloudflareTunnelSettings: jest.fn(),
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
    (webapp_client.conat_client.callHubApi as jest.Mock).mockImplementation(
      ({ name, args }) =>
        webapp_client.conat_client.hub.system[name.replace("system.", "")](
          ...args,
        ),
    );
  });

  const readyData = {
    ...baseData,
    r2_access_key_id: "access",
    r2_bucket_prefix: "cocalc",
  };
  const readySecrets = {
    project_hosts_cloudflare_tunnel_api_token: true,
    r2_api_token: true,
    r2_secret_access_key: true,
  };
  const bootstrapResult = {
    account_id: baseData.project_hosts_cloudflare_tunnel_account_id,
    account_name: "Selected account",
    zone_id: "zone",
    zone_name: "example.edu",
    durable_token_id: "durable-id",
    permissions: ["Workers Scripts Write", "DNS Write"],
    bootstrap_token_id: "temporary-id",
    bootstrap_token_invalidated: false,
    tunnel_token: { ok: true },
    visitor_location_headers: { ok: true },
    r2: { ok: true },
    notes: ["Discovery token revoked."],
    values: {
      ...readyData,
      project_hosts_cloudflare_tunnel_api_token: "must-not-apply",
      r2_api_token: "must-not-apply",
      r2_secret_access_key: "must-not-apply",
    },
  };

  it.each([
    ["none", baseData, {}, "Cloudflare credentials not configured"],
    ["complete", readyData, readySecrets, "Cloudflare credentials saved"],
    [
      "partial",
      readyData,
      { r2_api_token: true },
      "Cloudflare credential configuration is incomplete",
    ],
    [
      "missing S3 ID",
      baseData,
      readySecrets,
      "Cloudflare credential configuration is incomplete",
    ],
  ])(
    "shows %s saved credential state when reopening setup",
    async (_label, data, isSet, title) => {
      const props = { onClose: jest.fn(), data, isSet, onApply: jest.fn() };
      const { rerender } = render(<CloudflareConfigWizard {...props} open />);
      const status = () =>
        screen.getByRole("alert", {
          name: "Saved Cloudflare credential status",
        });
      await waitFor(() =>
        expect(within(status()).getByText(title)).toBeVisible(),
      );
      fireEvent.change(screen.getByRole("textbox", { name: "Domain name" }), {
        target: { value: "unsaved.example.edu" },
      });
      expect(within(status()).getByText(title)).toBeVisible();
      rerender(<CloudflareConfigWizard {...props} open={false} />);
      rerender(<CloudflareConfigWizard {...props} open />);
      await waitFor(() =>
        expect(within(status()).getByText(title)).toBeVisible(),
      );
      if (_label === "complete") {
        expect(status()).toHaveTextContent(
          "Run diagnostics below to verify access",
        );
        expect(status()).toHaveTextContent("existing R2 S3 keys are preserved");
      }
      if (_label === "missing S3 ID") {
        expect(status()).toHaveTextContent(
          "Missing saved credentials: R2 S3 access key ID.",
        );
      }
    },
  );

  it("configures S3 from bootstrap without manual keys or a second settings save", async () => {
    const onApply = jest.fn();
    const bootstrap = webapp_client.conat_client.hub.system
      .bootstrapCloudflareConfiguration as jest.Mock;
    bootstrap.mockResolvedValueOnce(bootstrapResult);
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={baseData}
        isSet={{}}
        onApply={onApply}
      />,
    );
    expect(
      screen.queryByRole("textbox", { name: "R2 Access Key ID" }),
    ).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "R2 Secret Access Key" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Provision or retry blob storage" }),
    ).toBeDisabled();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Temporary bootstrap token" }),
      {
        target: { value: "temporary" },
      },
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: "Bootstrap and save Cloudflare",
        }),
      ),
    );
    expect(
      screen.getByRole("button", { name: "Provision or retry blob storage" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Apply Settings" }),
    ).toBeDisabled();
    expect(document.body).toHaveTextContent(
      "R2 credentials are saved. No keys to paste",
    );
    expect(document.body).not.toHaveTextContent("must-not-apply");
    expect(
      screen.queryByRole("alert", {
        name: "Saved Cloudflare credential status",
      }),
    ).toBeNull();
    expect(screen.getAllByText("Cloudflare configuration saved")).toHaveLength(
      1,
    );
    expect(onApply).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("radio", { name: "Advanced manual setup" }),
    ).toBeNull();
  });

  it("links to a single-permission user bootstrap template without leaking the token", () => {
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={jest.fn()}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Temporary bootstrap token" }),
      { target: { value: "secret-never-in-a-link" } },
    );
    const link = screen.getByRole("link", {
      name: "https://dash.cloudflare.com/profile/api-tokens",
    });
    const url = new URL(link.getAttribute("href")!);
    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.pathname).toBe("/profile/api-tokens");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      permissionGroupKeys: JSON.stringify([
        { key: "api_tokens", type: "edit" },
      ]),
      accountId: "*",
      zoneId: "all",
      name: "CoCalc temporary bootstrap - cocalc.example.edu",
    });
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(document.body).toHaveTextContent("Leave Start Date unset");
    expect(document.body).toHaveTextContent(
      `Set End Date to ${bootstrapTokenEndDate()} (tomorrow in UTC)`,
    );
    expect(document.body).not.toHaveTextContent("15-60");
    fireEvent.change(screen.getByRole("textbox", { name: "Domain name" }), {
      target: { value: "example.edu&permissionGroupKeys=unexpected" },
    });
    const updated = new URL(link.getAttribute("href")!);
    expect(updated.searchParams.getAll("permissionGroupKeys")).toEqual([
      url.searchParams.get("permissionGroupKeys"),
    ]);
    expect(updated.searchParams.get("name")).toBe(
      "CoCalc temporary bootstrap - example.edu&permissionGroupKeys=unexpected",
    );
  });

  it("keeps security details collapsed and keyboard accessible", async () => {
    const user = userEvent.setup();
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={jest.fn()}
      />,
    );
    const summary = screen.getByText(
      "Permissions, security, and token handling",
    );
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(screen.queryByText(/If Cloudflare does not prefill/)).toBeNull();
    screen
      .getByRole("link", {
        name: "https://dash.cloudflare.com/profile/api-tokens",
      })
      .focus();
    await user.tab();
    expect(summary).toHaveFocus();
    // jsdom does not emulate native summary keyboard activation; exercise
    // native disclosure toggling by click and keyboard reachability by Tab.
    await user.click(summary);
    expect(details).toHaveAttribute("open");
    expect(details).toHaveTextContent("including tokens with R2 access");
    await user.click(summary);
    expect(details).not.toHaveAttribute("open");
    expect(summary).toHaveFocus();
  });

  it("offers only bootstrap and no manual credential fields", () => {
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={jest.fn()}
      />,
    );
    expect(
      screen.queryByRole("radio", { name: "Advanced manual setup" }),
    ).toBeNull();
    for (const name of [
      "Cloudflare Account ID",
      "Cloudflare API Token",
      "R2 API Token",
      "R2 Access Key ID",
      "R2 Secret Access Key",
    ]) {
      expect(screen.queryByRole("textbox", { name })).toBeNull();
    }
    expect(document.body).not.toHaveTextContent(/screenshot/i);
    expect(document.querySelector("img")).toBeNull();
    expect(
      screen
        .getAllByRole("heading", { level: 5 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "Step 1 - Cloudflare mode",
      "Step 2 - External domain",
      "Step 3 - Cloudflare Tokens",
      "Step 4 - Ensure R2 is Enabled in your Cloudflare account",
      "Step 5 - Resource names",
      "Step 6 - Diagnostics",
    ]);
    expect(
      screen.getByRole("link", { name: "Cloudflare dashboard" }),
    ).toHaveAttribute("href", "https://dash.cloudflare.com/");
    expect(
      screen.getByRole("link", { name: "R2 setup guide" }),
    ).toHaveAttribute(
      "href",
      "https://developers.cloudflare.com/r2/get-started/",
    );
    expect(document.body).toHaveTextContent(
      "left navigation panel (expand it if collapsed)",
    );
    expect(document.body).toHaveTextContent(
      "Storage & databases > R2 Object Storage",
    );
    expect(document.body).not.toHaveTextContent("R2 > Overview");
    expect(document.body).toHaveTextContent(
      "complete the subscription checkout",
    );
    expect(document.body).toHaveTextContent(
      "do not need to create buckets or keys manually",
    );
    expect(
      screen.getByRole("textbox", { name: "R2 bucket prefix" }),
    ).toBeDisabled();
  });

  it.each([
    ["2026-09-08T17:49:00-07:00", "2026-09-10"],
    ["2026-12-31T23:59:59Z", "2027-01-01"],
  ])("recommends a future UTC expiry for %s", (now, expected) => {
    expect(bootstrapTokenEndDate(new Date(now))).toBe(expected);
  });

  it("shows one verification failure instead of unrun capability errors", async () => {
    const bootstrap = webapp_client.conat_client.hub.system
      .bootstrapCloudflareConfiguration as jest.Mock;
    bootstrap.mockResolvedValueOnce({
      permissions: [],
      values: {},
      notes: [],
      settings_status: "not_saved",
      failure:
        "Unable to verify the bootstrap token. The bootstrap token has expired.",
      tunnel_token: { ok: false },
      visitor_location_headers: { ok: false },
      r2: { ok: false },
    });
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={jest.fn()}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Temporary bootstrap token" }),
      { target: { value: "temporary" } },
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Bootstrap and save Cloudflare" }),
      ),
    );
    expect(document.body).toHaveTextContent("The bootstrap token has expired");
    expect(document.body).toHaveTextContent("No site settings were changed");
    expect(document.body).toHaveTextContent(
      "Later configuration checks were not run",
    );
    expect(screen.queryByText("Tunnel capability")).toBeNull();
    expect(screen.queryByText("Durable token ID")).toBeNull();
    expect(document.body).not.toHaveTextContent(
      "Saving may have partially completed",
    );
  });

  it("uses a five-minute timeout and resumes bootstrap only after fresh authentication", async () => {
    const user = userEvent.setup();
    const bootstrap = webapp_client.conat_client.hub.system
      .bootstrapCloudflareConfiguration as jest.Mock;
    bootstrap
      .mockRejectedValueOnce(
        Object.assign(new Error("fresh auth is required"), {
          code: "fresh_auth_required",
        }),
      )
      .mockResolvedValueOnce(bootstrapResult);
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={jest.fn()}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "Temporary bootstrap token",
    });
    await user.type(input, "transient-bootstrap");
    await user.click(
      screen.getByRole("button", { name: "Bootstrap and save Cloudflare" }),
    );
    expect(input).toHaveValue("");
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(webapp_client.conat_client.callHubApi).toHaveBeenCalledWith({
      name: "system.bootstrapCloudflareConfiguration",
      args: [
        expect.objectContaining({
          token: "transient-bootstrap",
          browser_id: "wizard-browser-session",
        }),
      ],
      timeout: 300000,
    });
    expect(
      screen.queryByText("Cloudflare bootstrap did not complete"),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Verify security action" }),
    );
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText("Cloudflare configuration saved"),
    ).toBeInTheDocument();
    expect(bootstrap.mock.calls[0][0].token).toBe("");
  });

  it("clears the transient bootstrap request on fresh-auth cancellation without retrying", async () => {
    const user = userEvent.setup();
    const bootstrap = webapp_client.conat_client.hub.system
      .bootstrapCloudflareConfiguration as jest.Mock;
    bootstrap.mockRejectedValueOnce({ code: "fresh_auth_required" });
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={jest.fn()}
      />,
    );
    await user.type(
      screen.getByRole("textbox", { name: "Temporary bootstrap token" }),
      "temporary",
    );
    await user.click(
      screen.getByRole("button", { name: "Bootstrap and save Cloudflare" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Cancel verification" }),
    );
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bootstrap.mock.calls[0][0].token).toBe("");
    expect(
      screen.getByText("Cloudflare bootstrap verification cancelled"),
    ).toBeInTheDocument();
  });

  it("does not automatically retry ambiguous bootstrap transport errors", async () => {
    const bootstrap = webapp_client.conat_client.hub.system
      .bootstrapCloudflareConfiguration as jest.Mock;
    bootstrap.mockRejectedValueOnce(new Error("timeout"));
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={jest.fn()}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Temporary bootstrap token" }),
      { target: { value: "temporary" } },
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Bootstrap and save Cloudflare" }),
      ),
    );
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Verify security action" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Cloudflare bootstrap did not complete"),
    ).toBeInTheDocument();
  });

  it("prevents bootstrap from racing pending blob provisioning", async () => {
    const reconcile = webapp_client.conat_client.hub.system
      .reconcileCloudflareBlobs as jest.Mock;
    let resolve!: (value: { ok: boolean }) => void;
    reconcile.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={jest.fn()}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "Temporary bootstrap token",
    });
    fireEvent.change(input, { target: { value: "temporary" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Provision or retry blob storage" }),
    );
    expect(input).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Bootstrap and save Cloudflare" }),
    ).toBeDisabled();
    await act(async () => resolve({ ok: true }));
    expect(input).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Bootstrap and save Cloudflare" }),
    ).toBeEnabled();
  });

  it("applies saved tunnel settings through fresh auth without exposing server details", async () => {
    const user = userEvent.setup();
    const applyTunnel = webapp_client.conat_client.hub.system
      .applyCloudflareTunnelSettings as jest.Mock;
    applyTunnel
      .mockRejectedValueOnce({ code: "fresh_auth_required" })
      .mockResolvedValueOnce({
        running: true,
        message: "private-server-details",
      });
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={jest.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Apply saved tunnel settings",
    });
    await user.click(button);
    expect(button).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Provision or retry blob storage" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Verify security action" }),
    );
    expect(applyTunnel).toHaveBeenCalledTimes(2);
    expect(webapp_client.conat_client.callHubApi).toHaveBeenLastCalledWith({
      name: "system.applyCloudflareTunnelSettings",
      args: [{ browser_id: webapp_client.browser_id }],
      timeout: 300000,
    });
    expect(
      screen.getByText("Saved tunnel settings applied; the tunnel is running."),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("private-server-details");
    fireEvent.change(screen.getByRole("textbox", { name: "Domain name" }), {
      target: { value: "changed.example.edu" },
    });
    expect(button).toBeDisabled();
  });

  it("sanitizes tunnel errors and leaves the apply button retryable", async () => {
    const applyTunnel = webapp_client.conat_client.hub.system
      .applyCloudflareTunnelSettings as jest.Mock;
    applyTunnel.mockRejectedValueOnce(new Error("private-token-details"));
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={jest.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Apply saved tunnel settings",
    });
    await act(async () => fireEvent.click(button));
    expect(
      screen.getByText(
        "Could not apply saved tunnel settings. Check saved configuration and retry.",
      ),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("private-token-details");
    expect(button).toBeEnabled();
  });

  it.each(["rejection", "legacy envelope"])(
    "reconciles with a five-minute timeout after fresh authentication (%s)",
    async (responseType) => {
      const user = userEvent.setup();
      const reconcile = webapp_client.conat_client.hub.system
        .reconcileCloudflareBlobs as jest.Mock;
      if (responseType === "rejection") {
        reconcile.mockRejectedValueOnce({ code: "fresh_auth_required" });
      } else {
        reconcile.mockResolvedValueOnce({
          error: "Error: fresh auth is required",
        });
      }
      reconcile.mockResolvedValueOnce({ ok: true });
      render(
        <CloudflareConfigWizard
          open
          onClose={() => {}}
          data={readyData}
          isSet={readySecrets}
          onApply={jest.fn()}
        />,
      );
      await user.click(
        screen.getByRole("button", { name: "Provision or retry blob storage" }),
      );
      expect(reconcile).toHaveBeenCalledTimes(1);
      await user.click(
        screen.getByRole("button", { name: "Verify security action" }),
      );
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(webapp_client.conat_client.callHubApi).toHaveBeenLastCalledWith({
        name: "system.reconcileCloudflareBlobs",
        args: [{ browser_id: "wizard-browser-session" }],
        timeout: 300000,
      });
      expect(
        screen.getByText("Blob storage is healthy and active"),
      ).toBeInTheDocument();
    },
  );

  it("clears bootstrap input on submit and never applies returned tokens", async () => {
    const onApply = jest.fn();
    let resolve!: (value: typeof bootstrapResult) => void;
    const bootstrap = webapp_client.conat_client.hub.system
      .bootstrapCloudflareConfiguration as jest.Mock;
    bootstrap.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={onApply}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "Temporary bootstrap token",
    });
    fireEvent.change(input, { target: { value: "one-time-secret" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Bootstrap and save Cloudflare" }),
    );
    expect(input).toHaveValue("");
    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "one-time-secret",
        domain: readyData.dns,
      }),
    );
    await act(async () => resolve(bootstrapResult));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("DNS Write");
    expect(
      screen.getByText(
        "Delete the temporary bootstrap token manually in Cloudflare",
      ),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("must-not-apply");
    fireEvent.change(
      screen.getByRole("textbox", { name: "Tunnel name prefix" }),
      {
        target: { value: "new-prefix" },
      },
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Apply Settings" })),
    );
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).not.toHaveProperty(
      "project_hosts_cloudflare_tunnel_api_token",
    );
    expect(onApply.mock.calls[0][0]).not.toHaveProperty("r2_api_token");
    expect(onApply.mock.calls[0][0]).not.toHaveProperty("r2_access_key_id");
    expect(onApply.mock.calls[0][0]).not.toHaveProperty("r2_secret_access_key");
  });

  it("clears failed bootstrap input without rendering raw RPC errors", async () => {
    (
      webapp_client.conat_client.hub.system
        .bootstrapCloudflareConfiguration as jest.Mock
    ).mockRejectedValue(new Error("sensitive-rpc-secret"));
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={jest.fn()}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "Temporary bootstrap token",
    });
    fireEvent.change(input, { target: { value: "sensitive-rpc-secret" } });
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Bootstrap and save Cloudflare" }),
      ),
    );
    expect(input).toHaveValue("");
    expect(
      screen.getByText("Cloudflare bootstrap did not complete"),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("sensitive-rpc-secret");
  });

  it("reports validation and cleanup failures without claiming a successful save", async () => {
    (
      webapp_client.conat_client.hub.system
        .bootstrapCloudflareConfiguration as jest.Mock
    ).mockResolvedValue({
      ...bootstrapResult,
      tunnel_token: { ok: false, message: "Validation failed" },
      notes: [
        "Saving status is ambiguous; review saved settings. Delete discovery token discovery-id.",
      ],
      values: {},
    });
    const onApply = jest.fn();
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={onApply}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Temporary bootstrap token" }),
      { target: { value: "temporary" } },
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Bootstrap and save Cloudflare" }),
      ),
    );
    expect(
      screen.getByText("Cloudflare bootstrap needs attention"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Cloudflare configuration saved"),
    ).not.toBeInTheDocument();
    expect(document.body).toHaveTextContent(
      "Delete discovery token discovery-id",
    );
    expect(onApply).not.toHaveBeenCalled();
  });

  it("supports keyboard secret visibility and clears bootstrap input when Cloudflare is disabled", async () => {
    const user = userEvent.setup();
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={jest.fn()}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "Temporary bootstrap token",
    });
    await user.type(input, "temporary");
    input.focus();
    await user.tab();
    expect(
      screen.getAllByRole("button", { name: "Show secret" })[0],
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Hide secret" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(input).toHaveFocus();
    const manual = screen.getByRole("radio", {
      name: "No Cloudflare (self-hosted only)",
    });
    act(() => manual.focus());
    await user.keyboard(" ");
    expect(manual).toBeChecked();
    expect(
      screen.queryByRole("textbox", { name: "Temporary bootstrap token" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("radio", { name: "Use my own Cloudflare account" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Temporary bootstrap token" }),
    ).toHaveValue("");
  });

  it("clears bootstrap input when closed and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    const props = {
      onClose,
      data: readyData,
      isSet: readySecrets,
      onApply: jest.fn(),
    };
    const { rerender } = render(
      <>
        <button>Open configuration</button>
        <CloudflareConfigWizard {...props} open={false} />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Open configuration" });
    trigger.focus();
    rerender(
      <>
        <button>Open configuration</button>
        <CloudflareConfigWizard {...props} open />
      </>,
    );
    await user.type(
      screen.getByRole("textbox", { name: "Temporary bootstrap token" }),
      "temporary",
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <>
        <button>Open configuration</button>
        <CloudflareConfigWizard {...props} open={false} />
      </>,
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(trigger).toHaveFocus();
    rerender(
      <>
        <button>Open configuration</button>
        <CloudflareConfigWizard {...props} open />
      </>,
    );
    expect(
      screen.getByRole("textbox", { name: "Temporary bootstrap token" }),
    ).toHaveValue("");
  });

  it("retries blob provisioning using saved credentials and activates only on success", async () => {
    const reconcile = webapp_client.conat_client.hub.system
      .reconcileCloudflareBlobs as jest.Mock;
    reconcile
      .mockResolvedValueOnce({ ok: false, message: "Health check pending" })
      .mockResolvedValueOnce({
        ok: true,
        bucket: "cocalc-blobs",
        worker: "blob-worker",
        public_url: "https://blobs.example.edu",
      });
    const onApply = jest.fn();
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={readyData}
        isSet={readySecrets}
        onApply={onApply}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Provision or retry blob storage",
    });
    await act(async () => fireEvent.click(button));
    expect(
      screen.queryByText("Blob storage is healthy and active"),
    ).not.toBeInTheDocument();
    expect(button).toBeEnabled();
    await act(async () => fireEvent.click(button));
    expect(reconcile).toHaveBeenNthCalledWith(1, {
      browser_id: "wizard-browser-session",
    });
    expect(reconcile).toHaveBeenNthCalledWith(2, {
      browser_id: "wizard-browser-session",
    });
    expect(
      screen.getByText("Blob storage is healthy and active"),
    ).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("explains that diagnostics use saved settings", () => {
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={{ ...baseData, r2_bucket_prefix: "cocalc" }}
        isSet={{ project_hosts_cloudflare_tunnel_api_token: true }}
        onApply={() => {}}
      />,
    );

    expect(screen.getByText("Step 6 - Diagnostics")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Settings saved. Test visitor location headers and R2 backup credentials.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Test Visitor Location Headers",
      }),
    ).toBeEnabled();
    const buttons = screen
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(buttons.indexOf("Test Visitor Location Headers")).toBeLessThan(
      buttons.indexOf("Test R2 Backup Credentials"),
    );
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

  it("enables apply when an existing install needs the default R2 bucket prefix saved", async () => {
    const onApply = jest.fn(async () => {});
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={{
          ...baseData,
          r2_access_key_id: "r2-access-key",
          r2_bucket_prefix: "",
        }}
        isSet={{
          project_hosts_cloudflare_tunnel_api_token: true,
          r2_api_token: true,
          r2_secret_access_key: true,
        }}
        onApply={onApply}
      />,
    );

    const apply = screen.getByRole("button", { name: "Apply Settings" });
    expect(apply).toBeEnabled();

    await act(async () => {
      fireEvent.click(apply);
    });

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        r2_bucket_prefix: "cocalc",
      }),
    );
  });

  it("disables the visitor-header check while Cloudflare runtime changes are only in draft", () => {
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={{ ...baseData, r2_bucket_prefix: "cocalc" }}
        isSet={{ project_hosts_cloudflare_tunnel_api_token: true }}
        onApply={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("cocalc.example.edu"), {
      target: { value: "new.example.edu" },
    });

    expect(
      screen.getByRole("button", {
        name: "Test Visitor Location Headers",
      }),
    ).toBeDisabled();
    expect(
      screen.queryByText(
        "Save and apply Cloudflare tunnel settings before testing visitor headers.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Apply settings before testing."),
    ).toBeInTheDocument();
  });

  it("saves the external domain as the canonical public DNS setting", async () => {
    const onApply = jest.fn(async () => {});
    const onClose = jest.fn();
    render(
      <CloudflareConfigWizard
        open
        onClose={onClose}
        data={readyData}
        isSet={{
          project_hosts_cloudflare_tunnel_api_token: true,
          r2_api_token: true,
          r2_secret_access_key: true,
        }}
        onApply={onApply}
      />,
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Tunnel name prefix" }),
      {
        target: { value: "updated-prefix" },
      },
    );
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
    expect(
      screen.getByRole("button", { name: "Apply Settings" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByText("Close").closest("button")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText("Discard unsaved Cloudflare settings?"),
    ).not.toBeInTheDocument();
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
        data={{ ...baseData, r2_bucket_prefix: "cocalc" }}
        isSet={{ project_hosts_cloudflare_tunnel_api_token: true }}
        onApply={() => {}}
      />,
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Test Visitor Location Headers",
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

  it("keeps a failed save dirty and does not show false success", async () => {
    const onApply = jest.fn(async () => {
      throw new Error("save rejected");
    });
    render(
      <CloudflareConfigWizard
        open
        onClose={() => {}}
        data={{
          ...baseData,
          r2_access_key_id: "r2-access-key",
          r2_bucket_prefix: "",
        }}
        isSet={{
          project_hosts_cloudflare_tunnel_api_token: true,
          r2_api_token: true,
          r2_secret_access_key: true,
        }}
        onApply={onApply}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply Settings" }));
    });

    expect(
      screen.getByText("Cloudflare settings were not saved"),
    ).toBeInTheDocument();
    expect(screen.getByText("save rejected")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Settings applied and saved. You can now run diagnostics.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Apply Settings" }),
    ).toBeEnabled();
  });
});
