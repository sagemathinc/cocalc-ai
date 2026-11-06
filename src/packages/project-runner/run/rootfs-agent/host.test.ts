jest.mock("../podman", () => ({
  projectPoolPodmanLauncher: jest.fn(),
  projectStartCounter: jest.fn(() => 0),
}));
jest.mock("../rootfs", () => ({ rootfsIdmapUid: jest.fn() }));

import { parseCgroup, parseProcStatus } from "./host";

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
