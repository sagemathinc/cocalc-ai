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
});
