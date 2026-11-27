import { checkPodmanLaunch } from "@cocalc/backend/podman/launch-policy";
import {
  execLaunchPolicy,
  hostRuntimeUidMode,
  keepIdSideUsernsArgs,
  projectLaunchPolicy,
  RuntimeUidModeUnavailableError,
  sideLaunchPolicy,
  SideLaunchUnavailableError,
} from "./podman-launch";
import { keepIdUsernsArgs, type RuntimeIdentity } from "./runtime-identity";

const env = (mode?: string) =>
  (mode == null ? {} : { COCALC_PROJECT_RUNTIME_UID_MODE: mode }) as any;

const keepId = (reason?: any): RuntimeIdentity => ({
  mode: "keep-id",
  usernsArgs: keepIdUsernsArgs(),
  status: {
    configured: reason ? "separate" : "keep-id",
    effective: "keep-id",
    ...(reason ? { reason } : {}),
  },
});

const separate: RuntimeIdentity = {
  mode: "separate",
  uid: 1073741824,
  gid: 1073741824,
  usernsArgs: ["--uidmap", "0:1:2001", "--uidmap", "2001:9:1"],
  status: { configured: "separate", effective: "separate" },
};

const PROJECT = "project-11111111-2222-4333-8444-555555555555";

describe("hostRuntimeUidMode", () => {
  it("takes the mode exactly as set", () => {
    expect(hostRuntimeUidMode(env())).toEqual({
      configured: "keep-id",
      state: "keep-id",
    });
    expect(hostRuntimeUidMode(env("")).state).toBe("keep-id");
    expect(hostRuntimeUidMode(env("keep-id")).state).toBe("keep-id");
    expect(hostRuntimeUidMode(env("separate")).state).toBe("separate");
    for (const value of [" separate", "separate ", "Separate", "keepid", "x"])
      // reported as "invalid", never as set (environment content)
      expect(hostRuntimeUidMode(env(value))).toEqual({
        configured: "invalid",
        state: "invalid",
      });
  });
});

describe("projectLaunchPolicy (the main start)", () => {
  it("keep-id host: today's arguments, unchanged", () => {
    const p = projectLaunchPolicy(keepId(), {
      env: env(),
      extraUserArgs: ["--user", "0:0"],
    });
    expect(p.verb).toBe("create");
    expect([...p.usernsArgs]).toEqual([
      "--userns=keep-id:uid=2001,gid=2001",
      "--user",
      "0:0",
    ]);
  });

  it("separate host: the separate identity's arguments", () => {
    const p = projectLaunchPolicy(separate, {
      env: env("separate"),
      extraUserArgs: ["--user", "0:0"],
    });
    expect([...p.usernsArgs]).toEqual([
      ...separate.usernsArgs,
      "--user",
      "0:0",
    ]);
  });

  it("separate host whose decision is keep-id: refused with the reason", () => {
    for (const reason of [
      "helper-old",
      "map-missing-block",
      "map-unparsable",
      "map-collision",
      "host-unsafe",
    ]) {
      let err: any;
      try {
        projectLaunchPolicy(keepId(reason), { env: env("separate") });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RuntimeUidModeUnavailableError);
      expect(err.reason).toBe(reason);
      expect(err.message).toBe(
        "This host can't start projects right now. Please try again later or contact support.",
      );
    }
  });

  it("invalid mode: refused, whatever the decision", () => {
    for (const identity of [keepId(), separate])
      expect(() =>
        projectLaunchPolicy(identity, { env: env("separte") }),
      ).toThrow(RuntimeUidModeUnavailableError);
  });

  it("a separate decision on a keep-id host is never launched", () => {
    expect(() => projectLaunchPolicy(separate, { env: env() })).toThrow(
      RuntimeUidModeUnavailableError,
    );
  });
});

describe("sideLaunchPolicy (L1-L6)", () => {
  // The literal arguments each launcher had on main: keep-id hosts get them
  // unchanged.
  const MAIN: Record<string, string[]> = {
    "acp-harness": [
      "--userns=keep-id:uid=2001,gid=2001",
      "--user",
      "2001:2001",
    ],
    codex: ["--userns=keep-id:uid=2001,gid=2001", "--user", "2001:2001"],
    "shared-browser": [
      "--userns=keep-id:uid=2001,gid=2001",
      "--user",
      "2001:2001",
    ],
    "sandbox-exec": [
      "--userns=keep-id:uid=2001,gid=2001",
      "--user",
      "2001:2001",
    ],
    "claude-controller": ["--userns=keep-id", "--user", "2000:2000"],
    "rootfs-scan": [],
  };

  it("keep-id host: each launcher's arguments from main", () => {
    for (const [kind, args] of Object.entries(MAIN)) {
      const p = sideLaunchPolicy(kind as any, "run", {
        env: env(),
        hostUid: 2000,
        hostGid: 2000,
      });
      expect([kind, [...p.usernsArgs]]).toEqual([kind, args]);
      expect(
        keepIdSideUsernsArgs(kind as any, { hostUid: 2000, hostGid: 2000 }),
      ).toEqual(args);
    }
  });

  it("separate or invalid host: every side launcher is refused", () => {
    for (const mode of ["separate", "nonsense"])
      for (const kind of Object.keys(MAIN)) {
        let err: any;
        try {
          sideLaunchPolicy(kind as any, "run", {
            env: env(mode),
            hostUid: 2000,
            hostGid: 2000,
          });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(SideLaunchUnavailableError);
        expect(err.reason).toBe(
          mode === "separate" ? "separate-host" : "mode-invalid",
        );
        expect(err.message).toBe(
          "This feature is not available on this host yet.",
        );
      }
  });

  it("a minted policy passes the wrappers' check with its own argv", () => {
    const p = sideLaunchPolicy("codex", "run", { env: env() });
    expect(() =>
      checkPodmanLaunch(["run", "--rm", ...p.usernsArgs, "img"], p),
    ).not.toThrow();
  });
});

describe("execLaunchPolicy", () => {
  it("into the project's own container: allowed in every valid mode", () => {
    for (const mode of [undefined, "separate"]) {
      const p = execLaunchPolicy(PROJECT, {
        userArgs: ["-u", "0:0"],
        env: env(mode),
      });
      expect(p.kind).toBe("exec-project");
      expect(() =>
        checkPodmanLaunch(["exec", "-u", "0:0", PROJECT, "ls"], p),
      ).not.toThrow();
    }
  });

  it("into a side container, or for a side feature: refused off keep-id", () => {
    expect(() => execLaunchPolicy("codex-x", { env: env("separate") })).toThrow(
      SideLaunchUnavailableError,
    );
    expect(() =>
      execLaunchPolicy(PROJECT, { feature: "codex", env: env("separate") }),
    ).toThrow(SideLaunchUnavailableError);
    // an invalid mode refuses every exec, even a plain one into the
    // project's own container
    expect(() => execLaunchPolicy(PROJECT, { env: env("bogus") })).toThrow(
      SideLaunchUnavailableError,
    );
    expect(() =>
      execLaunchPolicy(PROJECT, { feature: "codex", env: env("bogus") }),
    ).toThrow(SideLaunchUnavailableError);
    // keep-id: all allowed
    expect(() =>
      execLaunchPolicy("codex-x", { feature: "codex", env: env() }),
    ).not.toThrow();
  });

  it("userArgs must be --user/-u pairs", () => {
    expect(() =>
      execLaunchPolicy(PROJECT, { userArgs: ["--userns=host"] }),
    ).toThrow();
    expect(() => execLaunchPolicy(PROJECT, { userArgs: ["-u"] })).toThrow();
    expect(() =>
      execLaunchPolicy(PROJECT, { userArgs: ["-u", "2001:2001"] }),
    ).not.toThrow();
  });
});
