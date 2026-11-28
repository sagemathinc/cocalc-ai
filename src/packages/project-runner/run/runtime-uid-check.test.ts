import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRootlessParentMap,
  judgeProcesses,
  parseStartTime,
  parseStatus,
  parseSubuids,
  readProcessTable,
  RUNTIME_UID_INVARIANT,
  type CheckContext,
  type ProcFacts,
} from "./runtime-uid-check";
import { parseIdMap } from "./runtime-identity";

// Synthetic numbers with the shapes measured on a rootless-Podman host: a
// runtime user with two subordinate ranges, the separate block apart.
const RUNTIME = 3000;
const SEPARATE = 1073741824;
const SUBUIDS = [
  { start: 300000, length: 65536 },
  { start: 400000, length: 4000000 },
];
const map = (text: string) => parseIdMap(text.replace(/; /g, "\n"))!;
const IDENTITY = map("0 0 4294967295");
const PARENT = map("0 3000 1; 1 300000 65536; 65537 400000 4000000");
// a keep-id project container: 2001 inside is the runtime uid
const KEEP_ID_CONTAINER = map(
  "0 300000 2001; 2001 3000 1; 2002 302001 63535; 65537 400000 4000000",
);
const DAEMON = { user: "user:[1]", mnt: "mnt:[1]", pid: "pid:[1]" };
const PASTA = { dev: 7, ino: 42 };

const ctx = (configured: CheckContext["configured"]): CheckContext => ({
  runtimeUid: RUNTIME,
  separateUid: SEPARATE,
  daemon: DAEMON,
  subuids: SUBUIDS,
  pasta: [PASTA],
  // Podman's parent user namespace, as podman unshare reports it
  podmanUserNs: "user:[2]",
  configured,
});

let nextPid = 100;
const proc = (p: Partial<ProcFacts>): ProcFacts => ({
  pid: nextPid++,
  ruid: RUNTIME,
  nspid: [1],
  uidMap: IDENTITY,
  ns: DAEMON,
  cgroup: "0::/cocalc-host-services/x",
  ...p,
});

// The host services and Podman's own processes, as measured.
const HEALTHY: ProcFacts[] = [
  // the daemon and the host's services
  proc({}),
  proc({}),
  // not dumpable: workers, systemd --user, sudo (no namespace links)
  proc({ ns: undefined, nspid: [1] }),
  // podman, conmon, catatonit: parent user ns, own mount ns, host pid ns
  proc({
    uidMap: PARENT,
    ns: { user: "user:[2]", mnt: "mnt:[2]", pid: DAEMON.pid },
    cgroup: "0::/cocalc-project-pool/p1",
  }),
  // pasta: parent user ns, its own pid ns, the trusted binary
  proc({
    uidMap: PARENT,
    ns: { user: "user:[2]", mnt: "mnt:[3]", pid: "pid:[3]" },
    nspid: [500, 1],
    exe: PASTA,
  }),
];

// A separate project's processes: not the runtime uid.
const SEPARATE_PROJECT: ProcFacts[] = [
  proc({ ruid: SEPARATE, ns: undefined, cgroup: "0::/cocalc-project-pool/a" }),
  proc({ ruid: SEPARATE, ns: undefined, cgroup: "0::/cocalc-project-pool/a" }),
];

// A keep-id project's process: the runtime uid in a container pid ns.
const keepIdProject = (pidns: string) =>
  proc({
    uidMap: KEEP_ID_CONTAINER,
    ns: { user: `user:${pidns}`, mnt: `mnt:${pidns}`, pid: `pid:${pidns}` },
    nspid: [900, 5],
    cgroup: "0::/cocalc-project-pool/b",
  });

describe("judgeProcesses", () => {
  it("states the invariant", () => {
    expect(judgeProcesses([], ctx("separate")).invariant).toBe(
      RUNTIME_UID_INVARIANT,
    );
  });

  it("host services and Podman's infrastructure are allowed", () => {
    const r = judgeProcesses(
      [...HEALTHY, ...SEPARATE_PROJECT],
      ctx("separate"),
    );
    expect(r).toMatchObject({
      violations: 0,
      unknown: 0,
      partial: 1,
      old_mode_containers: 0,
    });
  });

  it("the runtime uid in a container's pid namespace is a violation", () => {
    const r = judgeProcesses(
      [
        ...HEALTHY,
        keepIdProject("[9]"),
        keepIdProject("[9]"),
        keepIdProject("[8]"),
      ],
      ctx("separate"),
    );
    expect(r.violations).toBe(3);
    // old-mode keep-id containers, by pid namespace
    expect(r.old_mode_containers).toBe(2);
    expect(r.detail?.[0]).toMatchObject({
      kind: "container-pid-namespace",
      cgroup: "project-pool",
      pid_depth: 2,
    });
  });

  it("a sandbox nested inside a keep-id container is a violation, not another container", () => {
    // a browser sandbox's own user and pid namespaces inside a container: the
    // runtime uid as the only id mapped, one pid namespace deeper
    const sandbox = (pidns: string) =>
      proc({
        uidMap: map("2001 3000 1"),
        ns: { user: "user:[20]", mnt: "mnt:[9]", pid: pidns },
        nspid: [950, 7, 1],
        cgroup: "0::/cocalc-project-pool/b",
      });
    const r = judgeProcesses(
      [
        ...HEALTHY,
        keepIdProject("[9]"),
        sandbox("pid:[21]"),
        sandbox("pid:[22]"),
      ],
      ctx("separate"),
    );
    expect(r.violations).toBe(3);
    expect(r.old_mode_containers).toBe(1);
    expect(r.detail?.[1]).toMatchObject({
      kind: "container-pid-namespace",
      uid_map: "2001 3000 1",
      pid_depth: 3,
    });
  });

  it("a container in Podman's parent user namespace that isn't pasta is a violation", () => {
    // what a launch without user namespace flags (rootless default) looks like
    const r = judgeProcesses(
      [
        ...HEALTHY,
        proc({
          uidMap: PARENT,
          ns: { user: "user:[2]", mnt: "mnt:[7]", pid: "pid:[7]" },
          nspid: [600, 1],
          exe: { dev: 7, ino: 99 },
          cgroup: "0::/user.slice/x",
        }),
      ],
      ctx("separate"),
    );
    expect(r.violations).toBe(1);
    expect(r.detail?.[0]).toMatchObject({ cgroup: "other" });
  });

  it("the runtime uid in an unknown user namespace outside the project pool is a violation", () => {
    const r = judgeProcesses(
      [
        ...HEALTHY,
        proc({
          uidMap: map("2001 3000 1"),
          ns: { user: "user:[5]", mnt: "mnt:[5]", pid: "pid:[5]" },
          nspid: [700, 3],
          cgroup: "0::/cocalc-host-services/y",
        }),
      ],
      ctx("separate"),
    );
    expect(r.violations).toBe(1);
    expect(r.detail?.[0]).toMatchObject({
      uid_map: "2001 3000 1",
      cgroup: "host-services",
    });
  });

  it("unreadable or changing processes are unknown, never fine", () => {
    const r = judgeProcesses(
      [
        ...HEALTHY,
        // not dumpable, but not in the host's namespaces
        proc({ ns: undefined, nspid: [800, 2], uidMap: KEEP_ID_CONTAINER }),
        // changed between reads (pid reused, or exited midway)
        proc({ unstable: true }),
        proc({ unstable: true, ruid: Number.NaN }),
      ],
      ctx("separate"),
    );
    expect(r).toMatchObject({ violations: 0, unknown: 3 });
  });

  it("the separate uid is fine on a separate host, old-mode on a keep-id one", () => {
    expect(
      judgeProcesses([...HEALTHY, ...SEPARATE_PROJECT], ctx("separate"))
        .old_mode_containers,
    ).toBe(0);
    const r = judgeProcesses(
      [...HEALTHY, ...SEPARATE_PROJECT, keepIdProject("[9]")],
      ctx("keep-id"),
    );
    // keep-id hosts run project code as the runtime uid by design
    expect(r.violations).toBeNull();
    expect(r.old_mode_containers).toBe(1);
  });

  it("an invalid configuration is judged like separate", () => {
    expect(
      judgeProcesses([...HEALTHY, keepIdProject("[9]")], ctx("invalid"))
        .violations,
    ).toBe(1);
  });

  it("binds Podman's namespace by identity, not by the shape of its map", () => {
    const conmon = (user: string, mnt = "mnt:[33]") =>
      proc({
        uidMap: PARENT,
        ns: { user, mnt, pid: DAEMON.pid },
      });
    // conmon: Podman's user namespace, a mount namespace of its own, the
    // host's pid namespace
    expect(
      judgeProcesses([conmon("user:[2]")], ctx("separate")).violations,
    ).toBe(0);
    // mutant: the same map in another user namespace (one minted with the
    // same subordinate ranges)
    expect(
      judgeProcesses([conmon("user:[99]")], ctx("separate")).violations,
    ).toBe(1);
    // mutant: the same map and user namespace, another mount namespace, but
    // a pid namespace of its own: a container, not Podman's infrastructure
    expect(
      judgeProcesses(
        [
          proc({
            uidMap: PARENT,
            ns: { user: "user:[2]", mnt: "mnt:[34]", pid: "pid:[34]" },
            nspid: [70, 1],
            exe: { dev: 7, ino: 1 },
          }),
        ],
        ctx("separate"),
      ).violations,
    ).toBe(1);
    // Podman's namespace unreadable: its processes are unknown, not fine
    const { podmanUserNs: _, ...unbound } = ctx("separate");
    expect(judgeProcesses([conmon("user:[2]")], unbound)).toMatchObject({
      violations: 0,
      unknown: 1,
    });
  });

  it("nothing is enrolled from what exists: a new namespace is not allowed", () => {
    // same shape as Podman's infrastructure but another pid namespace and a
    // binary that isn't pasta
    const r = judgeProcesses(
      [
        proc({
          uidMap: PARENT,
          ns: { user: "user:[2]", mnt: "mnt:[2]", pid: "pid:[4]" },
          nspid: [10, 1],
        }),
      ],
      ctx("separate"),
    );
    expect(r.violations).toBe(1);
  });
});

describe("parsing", () => {
  it("recognizes the rootless parent map against the subordinate ranges", () => {
    expect(isRootlessParentMap(PARENT, RUNTIME, SUBUIDS)).toBe(true);
    expect(isRootlessParentMap(PARENT, RUNTIME, SUBUIDS.slice(0, 1))).toBe(
      false,
    );
    expect(isRootlessParentMap(IDENTITY, RUNTIME, SUBUIDS)).toBe(false);
    expect(isRootlessParentMap(KEEP_ID_CONTAINER, RUNTIME, SUBUIDS)).toBe(
      false,
    );
    expect(
      isRootlessParentMap(
        map("0 3000 1; 1 300000 65536; 65537 400000 3999999"),
        RUNTIME,
        SUBUIDS,
      ),
    ).toBe(false);
  });

  it("reads subordinate ranges by user name or uid, in order", () => {
    expect(
      parseSubuids(
        "other:100000:65536\nhost:300000:65536\n3000:400000:4000000\nhost:1073741824:65536\n",
        { name: "host", uid: 3000 },
      ),
    ).toEqual([...SUBUIDS, { start: 1073741824, length: 65536 }]);
  });

  it("reads start time, real uid and NSpid", () => {
    expect(
      parseStartTime(
        "1234 (a (weird) name) S 1 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 98765 0 0",
      ),
    ).toBe("98765");
    expect(
      parseStatus("Name:\tx\nUid:\t3000\t3000\t3000\t3000\nNSpid:\t42\t1\n"),
    ).toEqual({ ruid: 3000, nspid: [42, 1] });
  });
});

describe("readProcessTable", () => {
  it("a process that vanishes on the retry stays unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "proc-"));
    const dir = join(root, "20");
    await mkdir(join(dir, "ns"), { recursive: true });
    await writeFile(join(dir, "status"), "Uid:\t0\t0\t0\t0\nNSpid:\t20\n");
    await writeFile(join(dir, "uid_map"), "0 0 4294967295\n");
    await writeFile(join(dir, "cgroup"), "0::/x\n");
    // the start time changes between the two reads of the first pass, then
    // the process is gone before the retry
    let reads = 0;
    const { readFile: realRead } = jest.requireActual("node:fs/promises");
    await writeFile(
      join(dir, "stat"),
      "20 (x) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1 0 0",
    );
    const fs = require("node:fs/promises");
    const spy = jest
      .spyOn(fs, "readFile")
      .mockImplementation(async (...args: any[]) => {
        if (`${args[0]}`.endsWith("/20/stat")) {
          reads += 1;
          if (reads === 2)
            return "20 (x) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 2 0 0";
          if (reads >= 3)
            throw Object.assign(Error("gone"), { code: "ENOENT" });
        }
        return realRead(...args);
      });
    try {
      const table = await readProcessTable({
        procRoot: root,
        wantNs: () => false,
      });
      expect(table).toHaveLength(1);
      expect(table[0]).toMatchObject({ pid: 20, unstable: true });
      expect(reads).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("reads a /proc tree; a process gone before its first read is unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "proc-"));
    const pid = async (n: number, status: string) => {
      await mkdir(join(root, `${n}`, "ns"), { recursive: true });
      await writeFile(
        join(root, `${n}`, "stat"),
        `${n} (x) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 555 0 0`,
      );
      await writeFile(join(root, `${n}`, "status"), status);
      await writeFile(join(root, `${n}`, "uid_map"), "0 0 4294967295\n");
      await writeFile(join(root, `${n}`, "cgroup"), "0::/x\n");
    };
    await pid(10, "Uid:\t3000\t3000\t3000\t3000\nNSpid:\t10\n");
    await pid(11, "Uid:\t0\t0\t0\t0\nNSpid:\t11\n");
    await mkdir(join(root, "12")); // no stat: gone
    const table = await readProcessTable({
      procRoot: root,
      wantNs: (ruid) => ruid === 3000,
    });
    const byPid = Object.fromEntries(table.map((p) => [p.pid, p]));
    // a listed pid gone before its first read is unknown, not dropped
    expect(Object.keys(byPid).sort()).toEqual(["10", "11", "12"]);
    expect(byPid[12]).toMatchObject({ unstable: true });
    expect(byPid[12].ruid).toBeNaN();
    // the namespace links of the fixture don't exist: an unexpected failure
    // marks the process unstable (unknown), not fine
    expect(byPid[10].unstable).toBe(true);
    expect(byPid[11]).toMatchObject({ ruid: 0, nspid: [11] });
  });
});
