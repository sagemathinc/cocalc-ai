import { buildPublicSiteSettings } from "./site-settings-public";

describe("buildPublicSiteSettings", () => {
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
