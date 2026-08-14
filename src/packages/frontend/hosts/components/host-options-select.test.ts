import {
  groupHostOptions,
  hostOptionsRevision,
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
      benchmarkCpuScore: 20024.5,
      benchmarkValueScore: 363993.18,
    },
    {
      value: "e2-standard-4",
      label: "e2-standard-4 · $0.30/hr",
      selectionLabel: "e2-standard-4",
      hourlyRate: 0.3,
      benchmarkCpuScore: 13010.75,
      benchmarkValueScore: 173475.83,
    },
    {
      value: "c3d-standard-4",
      label: "c3d-standard-4 · $0.31/hr",
      selectionLabel: "c3d-standard-4",
      hourlyRate: 0.31,
      benchmarkCpuScore: 23643,
      benchmarkValueScore: 423642.86,
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
      "c3d-standard-4",
      "c3-highcpu-8",
      "t2a-standard-4",
    ]);
  });

  it("sorts by machine type within each availability section", () => {
    expect(
      sortMachineTypeOptions(options, "type")?.map((opt) => opt.value),
    ).toEqual([
      "c3d-standard-4",
      "e2-standard-4",
      "n2d-standard-4",
      "c3-highcpu-8",
      "t2a-standard-4",
    ]);
  });

  it("sorts available machine types by CPU benchmark score when requested", () => {
    expect(
      sortMachineTypeOptions(options, "cpu")?.map((opt) => opt.value),
    ).toEqual([
      "c3d-standard-4",
      "n2d-standard-4",
      "e2-standard-4",
      "c3-highcpu-8",
      "t2a-standard-4",
    ]);
  });

  it("sorts available machine types by benchmark value when requested", () => {
    expect(
      sortMachineTypeOptions(options, "value")?.map((opt) => opt.value),
    ).toEqual([
      "c3d-standard-4",
      "n2d-standard-4",
      "e2-standard-4",
      "c3-highcpu-8",
      "t2a-standard-4",
    ]);
  });
});

describe("hostOptionsRevision", () => {
  it("changes when option order or regional prices change", () => {
    const cheapFirst = [
      { value: "small", label: "Small", hourlyRate: 1 },
      { value: "large", label: "Large", hourlyRate: 2 },
    ];
    const expensiveFirst = [cheapFirst[1], cheapFirst[0]];
    const repriced = [{ ...cheapFirst[0], hourlyRate: 3 }, cheapFirst[1]];

    expect(hostOptionsRevision(expensiveFirst)).not.toBe(
      hostOptionsRevision(cheapFirst),
    );
    expect(hostOptionsRevision(repriced)).not.toBe(
      hostOptionsRevision(cheapFirst),
    );
  });

  it("is stable for equivalent regenerated options", () => {
    expect(
      hostOptionsRevision([{ value: "small", label: "Small", hourlyRate: 1 }]),
    ).toBe(
      hostOptionsRevision([{ value: "small", label: "Small", hourlyRate: 1 }]),
    );
  });
});
