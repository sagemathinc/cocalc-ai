export {};

let mkdirMock: jest.Mock;
let getLaunchpadLocalConfigMock: jest.Mock;
let getLaunchpadRestPortMock: jest.Mock;
let getLaunchpadRestAuthMock: jest.Mock;
let maybeStartLaunchpadOnPremServicesMock: jest.Mock;

jest.mock("node:fs/promises", () => ({
  mkdir: (...args: any[]) => mkdirMock(...args),
}));

jest.mock("./mode", () => ({
  getLaunchpadLocalConfig: (...args: any[]) =>
    getLaunchpadLocalConfigMock(...args),
}));

jest.mock("./onprem-sshd", () => ({
  getLaunchpadRestPort: (...args: any[]) => getLaunchpadRestPortMock(...args),
  getLaunchpadRestAuth: (...args: any[]) => getLaunchpadRestAuthMock(...args),
  maybeStartLaunchpadOnPremServices: (...args: any[]) =>
    maybeStartLaunchpadOnPremServicesMock(...args),
}));

describe("launchpad rest rustic repo config", () => {
  beforeEach(() => {
    jest.resetModules();
    mkdirMock = jest.fn(async () => undefined);
    getLaunchpadLocalConfigMock = jest.fn(() => ({
      rest_port: 9444,
      backup_root: "/srv/cocalc-backups",
    }));
    getLaunchpadRestPortMock = jest.fn(() => 9444);
    getLaunchpadRestAuthMock = jest.fn(async () => ({
      user: "launchpad",
      password: "secret value",
    }));
    maybeStartLaunchpadOnPremServicesMock = jest.fn(async () => undefined);
    delete process.env.COCALC_ONPREM_REST_TUNNEL_LOCAL_PORT;
  });

  it("builds a rootfs rest repo config under backup_root/rustic/<root>", async () => {
    const { buildLaunchpadRestRusticRepoConfig } = await import("./rest-repo");
    const result = await buildLaunchpadRestRusticRepoConfig({
      root: "rootfs-images",
      password: "repo-password",
    });
    expect(result).toBeDefined();
    expect(maybeStartLaunchpadOnPremServicesMock).toHaveBeenCalled();
    expect(mkdirMock).toHaveBeenCalledWith(
      "/srv/cocalc-backups/rustic/rootfs-images",
      { recursive: true },
    );
    expect(result?.repo_selector).toBe("rest:rootfs-images");
    expect(result?.repo_root).toBe("/srv/cocalc-backups/rustic/rootfs-images");
    expect(result?.repo_toml).toContain(
      'repository = "rest:http://launchpad:secret%20value@127.0.0.1:9345/rootfs-images"',
    );
    expect(result?.repo_toml).toContain('password = "repo-password"');
  });

  it("returns undefined when the local rest-server is not configured", async () => {
    getLaunchpadLocalConfigMock.mockReturnValue({
      rest_port: undefined,
      backup_root: "/srv/cocalc-backups",
    });
    getLaunchpadRestPortMock.mockReturnValue(undefined);
    const { buildLaunchpadRestRusticRepoConfig } = await import("./rest-repo");
    const result = await buildLaunchpadRestRusticRepoConfig({
      root: "rootfs-images",
      password: "repo-password",
    });
    expect(result).toBeUndefined();
    expect(mkdirMock).not.toHaveBeenCalled();
  });
});
