import {
  cloudflaredReplica,
  cloudflaredTunnelArgs,
  replicaFileName,
} from "./cloudflared-systemd";

describe("cloudflared replicas", () => {
  it("treats a missing replica setting as replica 1 and rejects bad values", () => {
    expect(cloudflaredReplica(undefined)).toBe(1);
    expect(cloudflaredReplica("")).toBe(1);
    expect(cloudflaredReplica("2")).toBe(2);
    // Two units that both fell back to replica 1 would stop each other.
    expect(() => cloudflaredReplica("0")).toThrow(/invalid/);
    expect(() => cloudflaredReplica("two")).toThrow(/invalid/);
    expect(() => cloudflaredReplica("12")).toThrow(/invalid/);
  });

  it("keeps replica 1's file names and gives the others their own", () => {
    expect(replicaFileName("config.yml", 1)).toBe("config.yml");
    expect(replicaFileName("config.yml", 2)).toBe("config-2.yml");
    expect(replicaFileName("credentials.json", 2)).toBe("credentials-2.json");
    expect(replicaFileName("cloudflared.pid", 3)).toBe("cloudflared-3.pid");
    // Replica 1 stops cloudflared processes whose arguments contain its config
    // path; another replica's config path must not contain it.
    expect(
      `/s/launchpad-cloudflare/${replicaFileName("config.yml", 2)}`.includes(
        "/s/launchpad-cloudflare/config.yml",
      ),
    ).toBe(false);
  });

  it("pins the metrics address when the replica has one", () => {
    expect(
      cloudflaredTunnelArgs({
        configPath: "/c/config-2.yml",
        metricsAddress: "127.0.0.1:20242",
      }),
    ).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--metrics",
      "127.0.0.1:20242",
      "--config",
      "/c/config-2.yml",
      "run",
    ]);
    expect(
      cloudflaredTunnelArgs({
        configPath: "/c/config.yml",
        metricsAddress: undefined,
      }),
    ).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--config",
      "/c/config.yml",
      "run",
    ]);
  });
});
