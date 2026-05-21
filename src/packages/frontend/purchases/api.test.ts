/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const adminProvisionSiteLicense = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-1",
    conat_client: {
      hub: {
        purchases: {
          adminProvisionSiteLicense: (...args: any[]) =>
            adminProvisionSiteLicense(...args),
        },
      },
    },
  },
}));

describe("purchases api", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes browser_id when provisioning a site license", async () => {
    adminProvisionSiteLicense.mockResolvedValue({ site_license: { id: "s1" } });
    const { adminProvisionSiteLicense: provision } = await import("./api");

    await provision({
      name: "Campus",
      organization_name: "Example University",
      allowed_domains: ["example.edu"],
      pools: [
        {
          pool_name: "Students",
          membership_class: "student",
          seat_count: 10,
          requires_approval: false,
          verification_policy: "email-domain",
        },
      ],
    });

    expect(adminProvisionSiteLicense).toHaveBeenCalledWith(
      expect.objectContaining({
        browser_id: "browser-1",
        name: "Campus",
      }),
    );
  });
});
