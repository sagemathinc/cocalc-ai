import {
  allowedPublicViewerSourceBaseHosts,
  derivePublicViewerDns,
  derivePublicViewerHostname,
  isAllowedPublicViewerSourceHost,
  normalizeOriginUrl,
  resolvePublicViewerDns,
} from "./public-viewer-origin";

describe("public viewer origin helpers", () => {
  it("derives a default raw hostname from apex and subdomain dns", () => {
    expect(derivePublicViewerHostname("cocalc.ai")).toBe("raw.cocalc.ai");
    expect(derivePublicViewerHostname("dev.cocalc.ai")).toBe(
      "dev-raw.cocalc.ai",
    );
    expect(derivePublicViewerHostname("raw.dev.cocalc.ai")).toBe(
      "raw.dev.cocalc.ai",
    );
  });

  it("preserves protocol and port when deriving public viewer dns", () => {
    expect(derivePublicViewerDns("http://dev.cocalc.ai:7001")).toBe(
      "http://dev-raw.cocalc.ai:7001",
    );
    expect(derivePublicViewerDns("cocalc.ai")).toBe("raw.cocalc.ai");
  });

  it("prefers an explicit public viewer dns when configured", () => {
    expect(
      resolvePublicViewerDns({
        publicViewerDns: "raw.dev.cocalc.ai",
        dns: "dev.cocalc.ai",
      }),
    ).toBe("raw.dev.cocalc.ai");
    expect(resolvePublicViewerDns({ dns: "dev.cocalc.ai" })).toBe(
      "dev-raw.cocalc.ai",
    );
  });

  it("normalizes host-like values into origins", () => {
    expect(normalizeOriginUrl("dev-raw.cocalc.ai")).toBe(
      "https://dev-raw.cocalc.ai",
    );
    expect(normalizeOriginUrl("http://raw.dev.cocalc.ai:7001")).toBe(
      "http://raw.dev.cocalc.ai:7001",
    );
  });

  it("allows project-host source domains that match the raw viewer base domain", () => {
    expect(allowedPublicViewerSourceBaseHosts("dev-raw.cocalc.ai")).toEqual([
      "dev-raw.cocalc.ai",
      "dev.cocalc.ai",
    ]);
    expect(
      isAllowedPublicViewerSourceHost({
        sourceHostname: "host-123-dev.cocalc.ai",
        viewerHostname: "dev-raw.cocalc.ai",
      }),
    ).toBe(true);
    expect(
      isAllowedPublicViewerSourceHost({
        sourceHostname: "host-123.cocalc.ai",
        viewerHostname: "raw.cocalc.ai",
      }),
    ).toBe(true);
    expect(
      isAllowedPublicViewerSourceHost({
        sourceHostname: "evil.example.com",
        viewerHostname: "dev-raw.cocalc.ai",
      }),
    ).toBe(false);
  });
});
