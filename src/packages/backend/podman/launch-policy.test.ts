import {
  checkPodmanLaunch,
  podmanExecTarget,
  podmanLaunchVerb,
} from "./launch-policy";
import { mintPodmanLaunchPolicy } from "./launch-policy-mint";
import { PodmanLaunchPolicy } from "./launch-policy";

const KEEP_ID = ["--userns=keep-id:uid=2001,gid=2001", "--user", "2001:2001"];

const policy = (
  verb: "create" | "run" | "exec" | "build",
  usernsArgs: string[] = KEEP_ID,
  container?: string,
) => mintPodmanLaunchPolicy({ kind: "codex", verb, usernsArgs, container });

describe("podmanLaunchVerb", () => {
  it("finds the verb after global options, and container/image forms", () => {
    expect(podmanLaunchVerb(["run", "x"])).toBe("run");
    expect(podmanLaunchVerb(["--log-level=debug", "create", "x"])).toBe(
      "create",
    );
    expect(podmanLaunchVerb(["--root", "/r", "exec", "c", "ls"])).toBe("exec");
    expect(podmanLaunchVerb(["container", "run", "x"])).toBe("run");
    expect(podmanLaunchVerb(["image", "build", "."])).toBe("build");
    expect(podmanLaunchVerb(["buildx", "build", "."])).toBe("build");
    for (const args of [
      ["ps", "-a"],
      ["rm", "-f", "x"],
      ["start", "--attach", "x"],
      ["unshare", "cat", "/proc/self/uid_map"],
      ["inspect", "x"],
      [],
    ])
      expect(podmanLaunchVerb(args)).toBeUndefined();
  });
});

describe("checkPodmanLaunch", () => {
  it("lets other verbs through without a policy", () => {
    expect(() => checkPodmanLaunch(["ps", "-a"], undefined)).not.toThrow();
  });

  it("refuses a launch without a policy, or with one for another verb", () => {
    expect(() =>
      checkPodmanLaunch(["run", ...KEEP_ID, "x"], undefined),
    ).toThrow(/needs a launch policy/);
    expect(() =>
      checkPodmanLaunch(["run", ...KEEP_ID, "x"], policy("create")),
    ).toThrow(/policy for create/);
  });

  it("refuses a policy that wasn't minted by the gate", () => {
    expect(
      () => new (PodmanLaunchPolicy as any)(Symbol("fake"), { verb: "run" }),
    ).toThrow(/minted only by the launch gate/);
    // an object that only claims the prototype is not a policy
    const fake = Object.create(PodmanLaunchPolicy.prototype);
    Object.assign(fake, { verb: "run", usernsArgs: [] });
    expect(() => checkPodmanLaunch(["run", "x"], fake)).toThrow(
      /needs a launch policy/,
    );
  });

  it("allows exactly the policy's user namespace flags, once, contiguously", () => {
    expect(() =>
      checkPodmanLaunch(
        ["create", "--name", "a", ...KEEP_ID, "img"],
        policy("create"),
      ),
    ).not.toThrow();
    for (const args of [
      // missing
      ["create", "--name", "a", "img"],
      // split
      ["create", KEEP_ID[0], "--name", "a", KEEP_ID[1], KEEP_ID[2], "img"],
      // twice
      ["create", ...KEEP_ID, ...KEEP_ID, "img"],
      // extra flags beside them
      ["create", ...KEEP_ID, "--userns=host", "img"],
      ["create", ...KEEP_ID, "--uidmap", "0:0:1", "img"],
      ["create", ...KEEP_ID, "--gidmap=0:0:1", "img"],
      ["create", ...KEEP_ID, "-u", "0", "img"],
      ["create", ...KEEP_ID, "--user=0", "img"],
      ["create", ...KEEP_ID, "--subuidname", "x", "img"],
    ])
      expect(() => checkPodmanLaunch(args, policy("create"))).toThrow(
        /user namespace flags/,
      );
  });

  it("an empty policy allows no user namespace flags at all", () => {
    expect(() =>
      checkPodmanLaunch(["run", "--rm", "img"], policy("run", [])),
    ).not.toThrow();
    expect(() =>
      checkPodmanLaunch(["run", "--userns=keep-id", "img"], policy("run", [])),
    ).toThrow(/user namespace flags/);
  });

  it("an exec must target its policy's container", () => {
    const p = policy("exec", ["-u", "2001:2001"], "project-1");
    expect(() =>
      checkPodmanLaunch(["exec", "-u", "2001:2001", "project-1", "ls"], p),
    ).not.toThrow();
    expect(() =>
      checkPodmanLaunch(["exec", "-u", "2001:2001", "codex-2", "ls"], p),
    ).toThrow(/must target/);
  });

  it("binds the exec to its actual container operand, not any argument", () => {
    const p = policy("exec", ["-u", "2001:2001"], "project-1");
    // the allowed name later, as a command argument
    expect(() =>
      checkPodmanLaunch(
        ["exec", "-u", "2001:2001", "other", "sh", "-c", "project-1"],
        p,
      ),
    ).toThrow(/must target/);
    // ... or as an option's value
    expect(() =>
      checkPodmanLaunch(
        ["exec", "-e", "project-1", "-u", "2001:2001", "other", "ls"],
        p,
      ),
    ).toThrow(/must target/);
    // options whose target can't be bound are refused
    for (const extra of [["--latest"], ["-l"], ["--privileged"], ["-x"]])
      expect(() =>
        checkPodmanLaunch(
          ["exec", ...extra, "-u", "2001:2001", "project-1", "ls"],
          p,
        ),
      ).toThrow(/must target/);
  });

  it("refuses an extra attached short user option (-u0, -itu0)", () => {
    const p = policy("exec", ["-u", "2001:2001"], "project-1");
    expect(() =>
      checkPodmanLaunch(["exec", "-u", "2001:2001", "project-1", "id"], p),
    ).not.toThrow();
    expect(() =>
      checkPodmanLaunch(
        ["exec", "-it", "-u", "2001:2001", "project-1", "id"],
        p,
      ),
    ).not.toThrow();
    for (const extra of ["-u0", "-itu0", "-du0:0", "-u=0"])
      expect(() =>
        checkPodmanLaunch(
          ["exec", "-u", "2001:2001", extra, "project-1", "id"],
          p,
        ),
      ).toThrow(/didn't come from the launch policy/);
    // and on run, against a keep-id policy
    const r = policy("run");
    expect(() =>
      checkPodmanLaunch(["run", "--rm", ...KEEP_ID, "-itu0", "img"], r),
    ).toThrow(/didn't come from the launch policy/);
    // a value that merely contains a u is not a user option
    expect(() =>
      checkPodmanLaunch(
        ["exec", "-u", "2001:2001", "-eUSER=x", "project-1", "id"],
        p,
      ),
    ).not.toThrow();
  });

  it("finds the exec target through every option form", () => {
    const cases: [string[], string | undefined][] = [
      [["exec", "c", "ls"], "c"],
      [["container", "exec", "-it", "c", "sh"], "c"],
      [["--root", "/r", "exec", "-e", "A=1", "--env=B=2", "c"], "c"],
      [["exec", "-eA=1", "-u2001", "--workdir", "/w", "-d", "c"], "c"],
      [["exec", "-ie", "A=1", "c"], "c"],
      [["exec", "--interactive", "--user", "0:0", "--", "c", "x"], "c"],
      [["exec", "-u"], undefined],
      [["run", "c"], undefined],
    ];
    for (const [args, target] of cases)
      expect([args, podmanExecTarget(args)]).toEqual([args, target]);
  });

  it("refuses user namespace flags on a verb it doesn't gate, without a policy", () => {
    expect(() =>
      checkPodmanLaunch(["pod", "create", "--userns=host"], undefined),
    ).toThrow(/need a launch policy/);
  });
});
