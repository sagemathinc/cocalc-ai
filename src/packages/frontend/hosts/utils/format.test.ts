import { getHostSizeDisplay } from "./format";

describe("getHostSizeDisplay", () => {
  it("hides stale cpu and ram details when a stopped host has a newer configured machine type", () => {
    expect(
      getHostSizeDisplay({
        status: "off",
        size: "t2d-standard-4",
        machine: {
          cloud: "gcp",
          machine_type: "t2d-standard-2",
          metadata: {
            cpu: 4,
            ram_gb: 16,
          },
        },
      } as any),
    ).toEqual({
      primary: "t2d-standard-2",
    });
  });

  it("keeps reporting observed resources once the host is running", () => {
    expect(
      getHostSizeDisplay({
        status: "running",
        size: "t2d-standard-4",
        machine: {
          cloud: "gcp",
          machine_type: "t2d-standard-2",
          metadata: {
            cpu: 4,
            ram_gb: 16,
          },
        },
      } as any),
    ).toEqual({
      primary: "4 vCPU / 16 GiB",
      secondary: "t2d-standard-2",
    });
  });

  it("hides stale cpu and ram details for stopped cloud hosts even when size matches the configured machine type", () => {
    expect(
      getHostSizeDisplay({
        status: "off",
        size: "t2d-standard-2",
        machine: {
          cloud: "gcp",
          machine_type: "t2d-standard-2",
          metadata: {
            cpu: 4,
            ram_gb: 16,
          },
        },
      } as any),
    ).toEqual({
      primary: "t2d-standard-2",
    });
  });

  it("keeps self-host cpu and ram details when stopped", () => {
    expect(
      getHostSizeDisplay({
        status: "off",
        machine: {
          cloud: "self-host",
          metadata: {
            cpu: 4,
            ram_gb: 16,
          },
        },
      } as any),
    ).toMatchObject({
      primary: "4 vCPU / 16 GiB",
    });
  });
});
