jest.mock("../podman", () => ({
  projectPoolPodmanLauncher: jest.fn(),
  projectStartCounter: jest.fn(() => 0),
}));
jest.mock("../rootfs", () => ({ rootfsIdmapUid: jest.fn() }));

import {
  parseCgroup,
  parsePpid,
  parseProcStatus,
  pickAgentProcess,
} from "./host";

const STATUS = `Name:\tnode
Umask:\t0022
State:\tS (sleeping)
Tgid:\t4242
NSpid:\t4242\t17
Pid:\t4242
Uid:\t1073741824\t1073741824\t1073741824\t1073741824
Gid:\t1073741824\t1073741824\t1073741824\t1073741824
CapInh:\t0000000000000000
CapPrm:\t0000000000000000
CapEff:\t0000000000000000
CapBnd:\t00000000a80425fb
CapAmb:\t0000000000000000
NoNewPrivs:\t1
Seccomp:\t2
Seccomp_filters:\t1
`;

describe("rootfs agent host facts", () => {
  it("reads the authority fields of /proc/<pid>/status", () => {
    expect(parseProcStatus(STATUS)).toEqual({
      uid: [1073741824, 1073741824, 1073741824, 1073741824],
      gid: [1073741824, 1073741824, 1073741824, 1073741824],
      capEff: 0n,
      capAmb: 0n,
      noNewPrivs: 1,
      seccomp: 2,
      nspid: [4242, 17],
    });
  });

  it("reads capabilities exactly", () => {
    const st = parseProcStatus(
      STATUS.replace("CapEff:\t0000000000000000", "CapEff:\t0000000000200000"),
    );
    expect(st.capEff).toBe(1n << 21n);
  });

  it("refuses a status missing a field, or malformed", () => {
    expect(() =>
      parseProcStatus(STATUS.replace(/^NoNewPrivs.*$/m, "")),
    ).toThrow("status lacks NoNewPrivs");
    expect(() =>
      parseProcStatus(
        STATUS.replace("CapAmb:\t0000000000000000", "CapAmb:\tzz"),
      ),
    ).toThrow("malformed");
    expect(() =>
      parseProcStatus(STATUS.replace("Uid:\t1073741824", "Uid:\tx")),
    ).toThrow("malformed");
  });

  it("reads the cgroup v2 path", () => {
    expect(parseCgroup("0::/cocalc-project-pool/project-x\n")).toBe(
      "/cocalc-project-pool/project-x",
    );
    expect(() => parseCgroup("1:name=systemd:/x\n")).toThrow("no cgroup v2");
  });
});

describe("finding the agent's host process (never by its own word)", () => {
  const C = "pid:[4026532100]";
  const HOST = "pid:[4026531836]";
  const argv = ["/opt/cocalc/bin/node", "-e", "CODE", "--", "a".repeat(32)];
  const agent = {
    pid: 500,
    ppid: 400,
    pidns: C,
    parentPidns: HOST,
    cmdline: argv,
  };

  it("is the one process in the container whose parent is outside it, with exactly the spawn's command line", () => {
    expect(
      pickAgentProcess(
        [
          agent,
          // the container's init and the project's own processes
          {
            pid: 300,
            ppid: 290,
            pidns: C,
            parentPidns: HOST,
            cmdline: ["catatonit"],
          },
          { pid: 310, ppid: 300, pidns: C, parentPidns: C, cmdline: ["bash"] },
          // a host process with the same command line, not in the container
          { pid: 600, ppid: 1, pidns: HOST, parentPidns: HOST, cmdline: argv },
        ],
        C,
        argv,
      ),
    ).toBe(500);
  });

  it("can't be a decoy the project starts: its parent is inside the container", () => {
    // the agent's name is right there in /proc; a decoy copies it exactly
    const decoy = {
      pid: 777,
      ppid: 310,
      pidns: C,
      parentPidns: C,
      cmdline: argv,
    };
    const forkedByAgent = {
      pid: 778,
      ppid: 500,
      pidns: C,
      parentPidns: C,
      cmdline: argv,
    };
    expect(pickAgentProcess([agent, decoy, forkedByAgent], C, argv)).toBe(500);
    // without the real agent there is nothing to trust
    expect(() => pickAgentProcess([decoy, forkedByAgent], C, argv)).toThrow(
      "found 0 host processes",
    );
  });

  it("refuses two candidates, or an agent that changed its command line", () => {
    const another = { ...agent, pid: 501, ppid: 401 };
    expect(() => pickAgentProcess([agent, another], C, argv)).toThrow(
      "found 2 host processes",
    );
    const renamed = { ...agent, cmdline: ["node"] };
    expect(() => pickAgentProcess([renamed], C, argv)).toThrow(
      "found 0 host processes",
    );
    // an empty command line (a zombie, or cleared argv), or one cut short
    for (const cmdline of [[], argv.slice(0, 3), argv.slice(0, 4)]) {
      expect(() => pickAgentProcess([{ ...agent, cmdline }], C, argv)).toThrow(
        "found 0 host processes",
      );
    }
    const extraArg = { ...agent, cmdline: [...argv, "x"] };
    expect(() => pickAgentProcess([extraArg], C, argv)).toThrow(
      "found 0 host processes",
    );
  });

  it("reads PPid", () => {
    expect(parsePpid("Name:\tnode\nPPid:\t4242\n")).toBe(4242);
    expect(() => parsePpid("Name:\tnode\n")).toThrow("lacks PPid");
  });
});
