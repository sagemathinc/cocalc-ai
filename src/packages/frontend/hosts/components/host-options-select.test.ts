import { groupHostOptions } from "./host-options-select";

describe("groupHostOptions", () => {
  it("splits mixed option lists into available and unavailable sections", () => {
    const grouped = groupHostOptions([
      { value: "n2d-standard-4", label: "n2d-standard-4 · $0.22/hr" },
      {
        value: "t2a-standard-4",
        label: "t2a-standard-4 · unavailable",
        stateLabel: "unavailable",
      },
      {
        value: "c3-highcpu-8",
        label: "c3-highcpu-8 · price unavailable",
        stateLabel: "price unavailable",
      },
    ]);

    expect(grouped).toEqual([
      {
        label: "Available",
        options: [
          { value: "n2d-standard-4", label: "n2d-standard-4 · $0.22/hr" },
        ],
      },
      {
        label: "Unavailable in this region",
        options: [
          {
            value: "t2a-standard-4",
            label: "t2a-standard-4 · unavailable",
            stateLabel: "unavailable",
          },
          {
            value: "c3-highcpu-8",
            label: "c3-highcpu-8 · price unavailable",
            stateLabel: "price unavailable",
          },
        ],
      },
    ]);
  });

  it("keeps flat lists unchanged when everything is available", () => {
    const options = [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ];
    expect(groupHostOptions(options)).toEqual(options);
  });
});
