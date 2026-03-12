import { buildCreateHostPayload } from "./registry";

describe("buildCreateHostPayload", () => {
  it("preserves disk_gb from the host edit form for nebius", () => {
    const payload = buildCreateHostPayload(
      {
        provider: "nebius",
        name: "Nebius Host",
        region: "eu-north1",
        machine_type: "cpu-standard",
        disk_gb: 93,
        disk_type: "ssd_io_m3",
      },
      {
        fieldOptions: {
          region: [{ value: "eu-north1", label: "EU North" }],
          machine_type: [
            {
              value: "cpu-standard",
              label: "CPU Standard",
              meta: { gpus: 0 },
            },
          ],
        },
      },
    );

    expect(payload.machine?.disk_gb).toBe(93);
  });
});
