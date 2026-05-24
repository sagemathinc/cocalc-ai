/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  deriveProjectHostHostname,
  normalizeProjectHostSuffix,
} from "./derived-domains";

describe("derived cloud domains", () => {
  it("keeps bare project-host suffixes intact", () => {
    expect(normalizeProjectHostSuffix("lite2b")).toBe("-lite2b");
  });

  it("derives project hostnames under the site hostname with a hyphenated site label", () => {
    expect(
      deriveProjectHostHostname("abc", {
        dns: "https://lite2b.cocalc.ai",
      }),
    ).toBe("host-abc-lite2b.cocalc.ai");
  });

  it("honors explicit project-host suffixes", () => {
    expect(
      deriveProjectHostHostname("abc", {
        dns: "https://lite2b.cocalc.ai",
        project_hosts_cloudflare_tunnel_host_suffix: "-dev.cocalc.ai",
      }),
    ).toBe("host-abc-dev.cocalc.ai");
  });

  it("expands explicit bare project-host suffixes under the site domain", () => {
    expect(
      deriveProjectHostHostname("abc", {
        dns: "https://lite2b.cocalc.ai",
        project_hosts_cloudflare_tunnel_host_suffix: "lite2b",
      }),
    ).toBe("host-abc-lite2b.cocalc.ai");
  });

  it("nests non-site explicit bare suffixes below the site hostname", () => {
    expect(
      deriveProjectHostHostname("abc", {
        dns: "https://lite2b.cocalc.ai",
        project_hosts_cloudflare_tunnel_host_suffix: "staging",
      }),
    ).toBe("host-abc-staging.lite2b.cocalc.ai");
  });
});
