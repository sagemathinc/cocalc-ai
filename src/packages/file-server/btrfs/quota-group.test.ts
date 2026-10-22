import { parseQgroupRelations } from "./quota-group";

describe("parseQgroupRelations", () => {
  it("reads the groups a subvolume is in, and their members", () => {
    // btrfs qgroup show -prcF --raw <home>, btrfs-progs 6.6
    const stdout = `Qgroupid    Referenced    Exclusive Max referenced Parent     Child       Path
--------    ----------    --------- -------------- ------     -----       ----
0/256         52445184     52445184      209715200 1/100      -           project-1
1/100         60833792     60833792      272629760 -          0/256,0/257 <2 member qgroups>
`;
    expect(parseQgroupRelations(stdout)).toEqual([
      {
        qgroupid: "0/256",
        referenced: 52445184,
        max_referenced: 209715200,
        parents: ["1/100"],
        children: [],
      },
      {
        qgroupid: "1/100",
        referenced: 60833792,
        max_referenced: 272629760,
        parents: [],
        children: ["0/256", "0/257"],
      },
    ]);
  });

  it("reads a group without a limit, and skips anything else", () => {
    const stdout = `WARNING: qgroup data inconsistent, rescan recommended
Qgroupid Referenced Exclusive Max referenced Parent Child Path
1/7 0 0 none - - <0 member qgroups>
`;
    expect(parseQgroupRelations(stdout)).toEqual([
      {
        qgroupid: "1/7",
        referenced: 0,
        max_referenced: "none",
        parents: [],
        children: [],
      },
    ]);
  });
});
