import {
  groupHostOptions,
  sortMachineTypeOptions,
} from "./host-options-select";

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

describe("sortMachineTypeOptions", () => {
  const options = [
    {
      value: "n2d-standard-4",
      label: "n2d-standard-4 · $0.22/hr",
      selectionLabel: "n2d-standard-4",
      hourlyRate: 0.22,
    },
    {
      value: "e2-standard-4",
      label: "e2-standard-4 · $0.30/hr",
      selectionLabel: "e2-standard-4",
      hourlyRate: 0.3,
    },
    {
      value: "t2a-standard-4",
      label: "t2a-standard-4 · unavailable",
      selectionLabel: "t2a-standard-4",
      stateLabel: "unavailable",
    },
    {
      value: "c3-highcpu-8",
      label: "c3-highcpu-8 · price unavailable",
      selectionLabel: "c3-highcpu-8",
      stateLabel: "price unavailable",
    },
  ];

  it("sorts available machine types by ascending price and keeps unavailable options grouped last", () => {
    expect(
      sortMachineTypeOptions(options, "price")?.map((opt) => opt.value),
    ).toEqual([
      "n2d-standard-4",
      "e2-standard-4",
      "c3-highcpu-8",
      "t2a-standard-4",
    ]);
  });

  it("sorts by machine type within each availability section", () => {
    expect(
      sortMachineTypeOptions(options, "type")?.map((opt) => opt.value),
    ).toEqual([
      "e2-standard-4",
      "n2d-standard-4",
      "c3-highcpu-8",
      "t2a-standard-4",
    ]);
  });
});
