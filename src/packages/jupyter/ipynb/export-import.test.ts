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

  it("migrates legacy CoCalc markdown escaped delimiters once", () => {
    const ipynb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: {
          name: "python3",
          metadata: { cocalc: { origin: "cocalc.com" } },
        },
      },
      cells: [
        {
          id: "markdown-1",
          cell_type: "markdown",
          metadata: {},
          source: String.raw`Use \(literal parens\) and \[literal brackets\].`,
        },
        {
          id: "code-1",
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: String.raw`print("\(keep code untouched\)")`,
        },
      ],
    };

    const imported = new IPynbImporter();
    imported.import({ ipynb });

    expect(imported.cells()["markdown-1"].input).toBe(
      "Use (literal parens) and [literal brackets].",
    );
    expect(imported.cells()["code-1"].input).toBe(
      String.raw`print("\(keep code untouched\)")`,
    );
    expect(imported.metadata()?.cocalc?.schemaVersion).toBe(1);
  });

  it("does not re-migrate notebooks that already have cocalc schemaVersion 1", () => {
    const ipynb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        cocalc: { schemaVersion: 1 },
        kernelspec: {
          name: "python3",
          metadata: { cocalc: { origin: "cocalc.com" } },
        },
      },
      cells: [
        {
          id: "markdown-1",
          cell_type: "markdown",
          metadata: {},
          source: String.raw`Already intentional \(math\).`,
        },
      ],
    };

    const imported = new IPynbImporter();
    imported.import({ ipynb });

    expect(imported.cells()["markdown-1"].input).toBe(
      String.raw`Already intentional \(math\).`,
    );
    expect(imported.metadata()?.cocalc?.schemaVersion).toBe(1);
  });

  it("does not migrate escaped delimiters in non-CoCalc notebooks", () => {
    const ipynb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { name: "python3" },
      },
      cells: [
        {
          id: "markdown-1",
          cell_type: "markdown",
          metadata: {},
          source: String.raw`External notebook keeps \(math\).`,
        },
      ],
    };

    const imported = new IPynbImporter();
    imported.import({ ipynb });

    expect(imported.cells()["markdown-1"].input).toBe(
      String.raw`External notebook keeps \(math\).`,
    );
    expect(imported.metadata()).toBeUndefined();
  });
});
