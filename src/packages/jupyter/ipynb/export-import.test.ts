import { export_to_ipynb } from "./export-to-ipynb";
import { DEFAULT_IPYNB, IPynbImporter } from "./import-from-ipynb";

describe("ipynb format version defaults", () => {
  it("exports notebooks as nbformat 4.5 when cell ids are present", () => {
    const ipynb = export_to_ipynb({
      cell_list: ["cell-1"],
      cells: {
        "cell-1": {
          cell_type: "code",
          input: "print(2 + 3)",
          output: {},
          metadata: {},
        },
      },
    });

    expect(ipynb.nbformat).toBe(4);
    expect(ipynb.nbformat_minor).toBe(5);
    expect(ipynb.cells[0].id).toBe("cell-1");
  });

  it("defaults blank imported notebooks to nbformat 4.5", () => {
    expect(DEFAULT_IPYNB.nbformat).toBe(4);
    expect(DEFAULT_IPYNB.nbformat_minor).toBe(5);
  });

  it("preserves null execution_count instead of coercing it to zero", () => {
    const ipynb = export_to_ipynb({
      cell_list: ["cell-1"],
      cells: {
        "cell-1": {
          cell_type: "code",
          input: "print(2 + 3)",
          output: {},
          metadata: {},
          exec_count: null,
        },
      },
    });

    expect(ipynb.cells[0].execution_count).toBeNull();

    const imported = new IPynbImporter();
    imported.import({ ipynb });
    expect(imported.cells()["cell-1"].exec_count).toBeNull();
  });
});
