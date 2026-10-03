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
          metadata: { cocalc: { origin: "cocalc.ai" } },
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
          metadata: { cocalc: { origin: "cocalc.ai" } },
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

describe("importing a notebook over existing cells", () => {
  const ipynb = (cells: { id?: string; source: string }[]) => ({
    ...DEFAULT_IPYNB,
    cells: cells.map(({ id, source }) => ({
      ...(id != null ? { id } : {}),
      cell_type: "code",
      source,
      metadata: {},
      outputs: [],
      execution_count: null,
    })),
  });
  const imported = (file, existing_ids: string[]) => {
    const importer = new IPynbImporter();
    let n = 0;
    importer.import({ ipynb: file, existing_ids, new_id: () => `new${n++}` });
    const cells = Object.values(importer.cells()) as any[];
    return cells
      .sort((a, b) => a.pos - b.pos)
      .map((cell) => `${cell.id}:${cell.input}`);
  };

  it("keeps each cell's input with its own id when a cell was inserted", () => {
    // The file has a cell inserted before b; matching by position would give
    // x's input to b, b's to c, and so on.
    const file = ipynb([
      { id: "a", source: "A" },
      { id: "x", source: "X" },
      { id: "b", source: "B" },
      { id: "c", source: "C" },
    ]);
    expect(imported(file, ["a", "b", "c"])).toEqual([
      "a:A",
      "x:X",
      "b:B",
      "c:C",
    ]);
  });

  it("keeps ids when cells were deleted or moved", () => {
    const file = ipynb([
      { id: "c", source: "C" },
      { id: "a", source: "A" },
    ]);
    expect(imported(file, ["a", "b", "c"])).toEqual(["c:C", "a:A"]);
  });

  it("reuses existing ids by position for cells without ids", () => {
    const file = ipynb([{ source: "A" }, { source: "B" }, { source: "C" }]);
    expect(imported(file, ["a", "b"])).toEqual(["a:A", "b:B", "new0:C"]);
  });
});
