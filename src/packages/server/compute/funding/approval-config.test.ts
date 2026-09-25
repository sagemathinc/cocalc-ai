/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  deriveFundingApprovalHostname,
  resolveFundingApprovalConfiguration,
} from "./approval-config";

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: jest.fn(),
}));

const environment = { ...process.env };

beforeEach(() => {
  jest.resetAllMocks();
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("COCALC_FUNDING_APPROVAL_")) delete process.env[name];
  }
});

afterAll(() => {
  process.env = environment;
});

it("derives certificate-friendly approval hostnames", () => {
  expect(deriveFundingApprovalHostname("cocalc.ai")).toBe(
    "authorize.cocalc.ai",
  );
  expect(deriveFundingApprovalHostname("lite2b.cocalc.ai")).toBe(
    "lite2b-authorize.cocalc.ai",
  );
});

it("automatically configures approval for Stripe and managed Cloudflare", async () => {
  (getServerSettings as jest.Mock).mockResolvedValue({
    dns: "lite2b.cocalc.ai",
    stripe_publishable_key: "pk_live_test",
    stripe_secret_key: "sk_live_test",
    cloudflare_mode: "self",
    project_hosts_cloudflare_tunnel_account_id: "account",
    project_hosts_cloudflare_tunnel_api_token: "token",
  });
  await expect(resolveFundingApprovalConfiguration()).resolves.toEqual({
    state: "configured",
    source: "managed-cloudflare",
    config: {
      origin: "https://lite2b-authorize.cocalc.ai",
      listen_host: "127.0.0.2",
      listen_port: 19212,
      trusted_proxy_ip: "127.0.0.1",
      application_origins: ["https://lite2b.cocalc.ai"],
      webauthn_rp_id: "lite2b.cocalc.ai",
    },
  });
});

it("requires Cloudflare configuration when purchasing is enabled", async () => {
  (getServerSettings as jest.Mock).mockResolvedValue({
    dns: "cocalc.example",
    stripe_publishable_key: "pk_live_test",
    stripe_secret_key: "sk_live_test",
    cloudflare_mode: "none",
  });
  await expect(resolveFundingApprovalConfiguration()).resolves.toMatchObject({
    state: "configuration_required",
  });
});
