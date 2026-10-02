import { getExportKernelSpec } from "../export-kernelspec";

const selected = "remote-julia";
const saved = {
  name: selected,
  display_name: "Remote Julia",
  language: "julia",
};

describe("export kernelspec resolution", () => {
  it("prefers the matching catalog entry over saved metadata", () => {
    const info = { ...saved, display_name: "Current Julia" };
    expect(getExportKernelSpec(selected, info, { kernelspec: saved })).toBe(
      info,
    );
  });

  it("reuses compatible saved display and language without a catalog", () => {
    expect(
      getExportKernelSpec(selected, undefined, { kernelspec: saved }),
    ).toEqual(saved);
  });

  it("ignores the null-catalog No Kernel sentinel for a selected kernel", () => {
    expect(
      getExportKernelSpec(
        selected,
        { name: "No Kernel", display_name: "No Kernel", language: "" },
        { kernelspec: saved },
      ),
    ).toEqual(saved);
  });

  it.each([
    undefined,
    null,
    [],
    "invalid",
    { kernelspec: "invalid" },
    {
      kernelspec: {
        name: "python3",
        display_name: "Python",
        language: "python",
      },
    },
    { kernelspec: { display_name: "Python", language: "python" } },
    { kernelspec: { name: selected, display_name: 42, language: {} } },
    { kernelspec: { name: selected, display_name: " ", language: "" } },
  ])(
    "preserves the selection without inventing a language (%p)",
    (metadata) => {
      expect(getExportKernelSpec(selected, undefined, metadata)).toEqual({
        name: selected,
        display_name: selected,
      });
    },
  );

  it.each([undefined, null, ""])(
    "does not restore a stale saved selection (%p)",
    (kernel) => {
      expect(getExportKernelSpec(kernel, saved, { kernelspec: saved })).toEqual(
        { name: "", display_name: "No Kernel" },
      );
    },
  );
});
