import { buildPublicSiteSettings } from "./site-settings-public";

describe("buildPublicSiteSettings", () => {
  describe("browser versions", () => {
    const frontend = 1_700_000_000; // the version of the frontend this build serves

    it("never requires or recommends a newer frontend than the one served", () => {
      const { configuration, version } = buildPublicSiteSettings(
        {
          version_min_browser: `${frontend + 100}`,
          version_recommended_browser: `${frontend + 100}`,
        },
        frontend,
      );
      expect(version.version_min_browser).toBe(frontend);
      expect(version.version_recommended_browser).toBe(frontend);
      expect(configuration.version_min_browser).toBe(frontend);
      expect(configuration.version_recommended_browser).toBe(frontend);
    });

    it("keeps lower versions, and the required version capped at the recommended one", () => {
      const { version } = buildPublicSiteSettings(
        {
          version_min_browser: `${frontend - 10}`,
          version_recommended_browser: `${frontend - 20}`,
        },
        frontend,
      );
      expect(version.version_recommended_browser).toBe(frontend - 20);
      expect(version.version_min_browser).toBe(frontend - 20);
    });

    it("requires exactly the served version when both are set to it", () => {
      const { version } = buildPublicSiteSettings(
        {
          version_min_browser: `${frontend}`,
          version_recommended_browser: `${frontend}`,
        },
        frontend,
      );
      expect(version.version_min_browser).toBe(frontend);
    });
  });

  it("exposes the configured public status page URL", () => {
    expect(
      buildPublicSiteSettings({
        status_page_url: "https://status.example.com",
      }).configuration.status_page_url,
    ).toBe("https://status.example.com");
  });

  it("exposes the public email authentication mode", () => {
    expect(
      buildPublicSiteSettings({
        email_authentication_mode: "verify_after_signup",
      }).configuration.email_authentication_mode,
    ).toBe("verify_after_signup");
  });

  it("derives a public zendesk flag from private zendesk settings", () => {
    expect(
      buildPublicSiteSettings({
        zendesk_token: "secret",
        zendesk_username: "agent@example.com",
        zendesk_uri: "https://example.zendesk.com/api/v2",
      }).configuration.zendesk,
    ).toBe(true);

    expect(
      buildPublicSiteSettings({
        zendesk_token: "secret",
        zendesk_username: "",
        zendesk_uri: "https://example.zendesk.com/api/v2",
      }).configuration.zendesk,
    ).toBe(false);
  });

  it("derives a public stripe_enabled flag without exposing Stripe keys", () => {
    const { configuration } = buildPublicSiteSettings({
      stripe_publishable_key: "pk_test_123",
      stripe_secret_key: "sk_test_456",
    });

    expect(configuration.stripe_enabled).toBe(true);
    expect(configuration.stripe_publishable_key).toBeUndefined();
    expect(configuration.stripe_secret_key).toBeUndefined();
  });

  it("requires both Stripe keys for stripe_enabled", () => {
    expect(
      buildPublicSiteSettings({
        stripe_publishable_key: "pk_test_123",
        stripe_secret_key: "",
      }).configuration.stripe_enabled,
    ).toBe(false);
    expect(
      buildPublicSiteSettings({
        stripe_publishable_key: "",
        stripe_secret_key: "sk_test_456",
      }).configuration.stripe_enabled,
    ).toBe(false);
  });

  it("exposes only the public RootFS scan feature flag", () => {
    expect(
      buildPublicSiteSettings({
        rootfs_scan_enabled: "yes",
        rootfs_scan_container_image: "registry.example/trivy@sha256:secret",
        rootfs_scan_trivy_cache_dir: "/private/cache",
      }).configuration,
    ).toEqual(
      expect.objectContaining({
        rootfs_scan_enabled: true,
      }),
    );
    const disabled = buildPublicSiteSettings({
      rootfs_scan_enabled: "no",
    }).configuration;
    expect(disabled.rootfs_scan_enabled).toBe(false);
    expect(disabled.rootfs_scan_container_image).toBeUndefined();
    expect(disabled.rootfs_scan_trivy_cache_dir).toBeUndefined();
  });

  it("does not expose the removed legacy policy visibility flag", () => {
    expect(
      buildPublicSiteSettings({
        policy_pages: "sagemathinc",
        show_policies: "yes",
      }).configuration,
    ).toEqual(
      expect.objectContaining({
        policy_pages: "sagemathinc",
      }),
    );
    expect(
      buildPublicSiteSettings({
        show_policies: "yes",
      }).configuration.show_policies,
    ).toBeUndefined();
  });

  it("redacts raw signup domain policy lists and exposes only the safe public summary", () => {
    const { configuration } = buildPublicSiteSettings({
      signup_email_domain_policy_mode: "allow_only",
      signup_email_domain_allow_list: "example.edu *.school.edu",
      signup_email_domain_deny_list: "darkweb.example",
      signup_email_domain_show_allowed_domains: "yes",
    });

    expect(configuration.signup_email_domain_allow_list).toBeUndefined();
    expect(configuration.signup_email_domain_deny_list).toBeUndefined();
    expect(configuration.signup_email_domain_public_policy).toEqual({
      mode: "allow_only",
      message: "Use an approved email address: @example.edu, *.school.edu.",
      allowed_domains: ["@example.edu", "*.school.edu"],
    });
  });
});
