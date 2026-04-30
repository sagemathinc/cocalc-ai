/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  isProjectHostDevGcpReverseTunnelEnabled,
  resolveProjectHostBootstrapMasterConatServer,
  resolveProjectHostPreferredMasterConatServer,
  resolveProjectHostTunneledMasterConatLocalPort,
  resolveProjectHostTunneledMasterConatServer,
} from "./master-conat-server";

describe("project-host master conat server helpers", () => {
  const envKeys = [
    "COCALC_DEV_GCP_REVERSE_TUNNEL",
    "COCALC_BOOTSTRAP_MASTER_CONAT_SERVER",
    "COCALC_TUNNELED_MASTER_CONAT_SERVER",
    "COCALC_ONPREM_MASTER_CONAT_TUNNEL_LOCAL_PORT",
    "MASTER_CONAT_SERVER",
    "COCALC_MASTER_CONAT_SERVER",
  ] as const;

  const originalEnv = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  afterAll(() => {
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("uses bootstrap master address when no tunneled address is configured", () => {
    process.env.MASTER_CONAT_SERVER = "https://lite4b.cocalc.ai";
    expect(resolveProjectHostBootstrapMasterConatServer()).toBe(
      "https://lite4b.cocalc.ai",
    );
    expect(resolveProjectHostPreferredMasterConatServer()).toBe(
      "https://lite4b.cocalc.ai",
    );
  });

  it("prefers the explicit tunneled master address when configured", () => {
    process.env.MASTER_CONAT_SERVER = "https://lite4b.cocalc.ai";
    process.env.COCALC_TUNNELED_MASTER_CONAT_SERVER = "http://127.0.0.1:9346";
    expect(resolveProjectHostTunneledMasterConatLocalPort()).toBe(9346);
    expect(resolveProjectHostTunneledMasterConatServer()).toBe(
      "http://127.0.0.1:9346",
    );
    expect(resolveProjectHostPreferredMasterConatServer()).toBe(
      "http://127.0.0.1:9346",
    );
  });

  it("enables the default tunneled localhost address for dev GCP mode", () => {
    process.env.MASTER_CONAT_SERVER = "https://lite4b.cocalc.ai";
    process.env.COCALC_DEV_GCP_REVERSE_TUNNEL = "1";
    expect(isProjectHostDevGcpReverseTunnelEnabled()).toBe(true);
    expect(resolveProjectHostTunneledMasterConatLocalPort()).toBe(9346);
    expect(resolveProjectHostTunneledMasterConatServer()).toBe(
      "http://127.0.0.1:9346",
    );
    expect(resolveProjectHostPreferredMasterConatServer()).toBe(
      "http://127.0.0.1:9346",
    );
  });
});
