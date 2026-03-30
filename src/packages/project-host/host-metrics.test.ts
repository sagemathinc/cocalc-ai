import { _test } from "./host-metrics";

describe("host metrics parsers", () => {
  it("parses btrfs filesystem usage output", () => {
    const parsed = _test.parseBtrfsUsageOutput(`
Overall:
    Device size:                   536870912000
    Device allocated:              61733990400
    Device unallocated:           475136921600
    Device missing:                        0
    Device slack:                          0
    Used:                         48979247104
    Free (estimated):            485695602688      (min: 248127594496)
    Free (statfs, df):           485695602688
    Data ratio:                         1.00
    Metadata ratio:                     2.00
    Global reserve:               536870912      (used: 0)
    Multiple profiles:                    no

Data,single: Size:53687091200, Used:48000000000 (89.40%)
   /dev/nvme0n1p1   53687091200

Metadata,DUP: Size:4026531840, Used:981467136 (24.38%)
   /dev/nvme0n1p1   8053063680

System,DUP: Size:33554432, Used:16384 (0.05%)
   /dev/nvme0n1p1     67108864
`);

    expect(parsed.disk_device_total_bytes).toBe(536870912000);
    expect(parsed.disk_device_used_bytes).toBe(48979247104);
    expect(parsed.disk_unallocated_bytes).toBe(475136921600);
    expect(parsed.btrfs_data_total_bytes).toBe(53687091200);
    expect(parsed.btrfs_data_used_bytes).toBe(48000000000);
    expect(parsed.btrfs_metadata_total_bytes).toBe(4026531840);
    expect(parsed.btrfs_metadata_used_bytes).toBe(981467136);
    expect(parsed.btrfs_system_total_bytes).toBe(33554432);
    expect(parsed.btrfs_system_used_bytes).toBe(16384);
    expect(parsed.btrfs_global_reserve_total_bytes).toBe(536870912);
    expect(parsed.btrfs_global_reserve_used_bytes).toBe(0);
    expect(parsed.disk_available_conservative_bytes).toBe(248127594496);
  });

  it("parses unprivileged btrfs usage output with a warning banner", () => {
    const parsed = _test.parseBtrfsUsageOutput(`
WARNING: cannot read detailed chunk info, per-device usage will not be shown, run as root
Overall:
    Device size:                   214748364800
    Device allocated:               63375933440
    Device unallocated:            151372431360
    Device missing:                        0
    Device slack:                          0
    Used:                         53000417280
    Free (estimated):            160845189120      (min: 85158973440)
    Free (statfs, df):           160844140544
    Data ratio:                         1.00
    Metadata ratio:                     2.00
    Global reserve:               133873664      (used: 0)
    Multiple profiles:                    no

Data,single: Size:56916705280, Used:47443947520 (83.36%)
   /dev/sdb   56916705280

Metadata,DUP: Size:3221225472, Used:2778218496 (86.25%)
   /dev/sdb   6442450944

System,DUP: Size:8388608, Used:16384 (0.20%)
   /dev/sdb     16777216
`);

    expect(parsed.disk_device_total_bytes).toBe(214748364800);
    expect(parsed.btrfs_metadata_total_bytes).toBe(3221225472);
    expect(parsed.btrfs_metadata_used_bytes).toBe(2778218496);
    expect(parsed.disk_available_conservative_bytes).toBe(85158973440);
  });

  it("parses df output fallback", () => {
    const parsed = _test.parseDfOutput(`
     1B-blocks           Used      Avail
536870912000 48979247104 248127594496
`);

    expect(parsed.disk_device_total_bytes).toBe(536870912000);
    expect(parsed.disk_device_used_bytes).toBe(48979247104);
    expect(parsed.disk_available_conservative_bytes).toBe(248127594496);
  });
});
