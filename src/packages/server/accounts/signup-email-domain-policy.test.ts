/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const mockGetServerSettings = jest.fn();
const mockCentralLog = jest.fn();
const mockAllowedLabels = jest.fn();
const mockBlockedLabels = jest.fn();
const mockAllowedInc = jest.fn();
const mockBlockedInc = jest.fn();

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => mockGetServerSettings(...args),
}));

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCentralLog(...args),
}));

jest.mock("@cocalc/backend/metrics", () => ({
  newCounter: (_aspect: string, name: string) => {
    if (name === "signup_domain_policy_allowed_total") {
      return {
        labels: (...args: any[]) => {
          mockAllowedLabels(...args);
          return { inc: mockAllowedInc };
        },
      };
    }
    if (name === "signup_domain_policy_blocked_total") {
      return {
        labels: (...args: any[]) => {
          mockBlockedLabels(...args);
          return { inc: mockBlockedInc };
        },
      };
    }
    throw Error(`unexpected counter ${name}`);
  },
}));

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("signup email domain policy observability", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetServerSettings.mockReset();
    mockCentralLog.mockReset().mockResolvedValue(undefined);
    mockAllowedLabels.mockReset();
    mockBlockedLabels.mockReset();
    mockAllowedInc.mockReset();
    mockBlockedInc.mockReset();
  });

  it("counts allowed policy decisions with a bounded domain category", async () => {
    mockGetServerSettings.mockResolvedValue({
      signup_email_domain_policy_mode: "allow_only",
      signup_email_domain_allow_list: "school.edu",
    });
    const { assertSignupEmailDomainAllowed } =
      await import("./signup-email-domain-policy");

    await assertSignupEmailDomainAllowed({
      email_address: "Student@School.edu",
    });

    expect(mockAllowedLabels).toHaveBeenCalledWith(
      "allow_only",
      expect.stringMatching(/^sha256-[0-9a-f]{2}$/),
    );
    expect(mockAllowedInc).toHaveBeenCalledTimes(1);
    expect(mockBlockedInc).not.toHaveBeenCalled();
    expect(mockCentralLog).not.toHaveBeenCalled();
  });

  it("counts blocked policy decisions and logs them without raw email domains", async () => {
    mockGetServerSettings.mockResolvedValue({
      signup_email_domain_policy_mode: "deny_list",
      signup_email_domain_deny_list: "blocked.example",
    });
    const { assertSignupEmailDomainAllowed } =
      await import("./signup-email-domain-policy");

    await expect(
      assertSignupEmailDomainAllowed({
        email_address: "abuse@blocked.example",
      }),
    ).rejects.toThrow(
      "Account creation is not available for this email address.",
    );
    await flushPromises();

    expect(mockBlockedLabels).toHaveBeenCalledWith(
      "deny_list",
      expect.stringMatching(/^sha256-[0-9a-f]{2}$/),
    );
    expect(mockBlockedInc).toHaveBeenCalledTimes(1);
    expect(mockCentralLog).toHaveBeenCalledWith({
      event: "signup_email_domain_policy_blocked",
      value: {
        mode: "deny_list",
        domain_category: expect.stringMatching(/^sha256-[0-9a-f]{2}$/),
        public_details_allowed: false,
        suppression_window_ms: 300000,
      },
    });
    expect(JSON.stringify(mockCentralLog.mock.calls)).not.toContain(
      "blocked.example",
    );
  });

  it("rate-limits duplicate blocked policy logs by mode and domain category", async () => {
    mockGetServerSettings.mockResolvedValue({
      signup_email_domain_policy_mode: "deny_list",
      signup_email_domain_deny_list: "blocked.example",
    });
    const { assertSignupEmailDomainAllowed } =
      await import("./signup-email-domain-policy");

    for (let i = 0; i < 2; i += 1) {
      await expect(
        assertSignupEmailDomainAllowed({
          email_address: `abuse-${i}@blocked.example`,
        }),
      ).rejects.toThrow();
    }
    await flushPromises();

    expect(mockBlockedInc).toHaveBeenCalledTimes(2);
    expect(mockCentralLog).toHaveBeenCalledTimes(1);
  });
});
