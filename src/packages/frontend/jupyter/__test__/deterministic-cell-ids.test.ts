import { IPynbImporter } from "@cocalc/jupyter/ipynb/import-from-ipynb";
import { deep_copy } from "@cocalc/util/misc";
import { withDeterministicCellIds } from "../deterministic-cell-ids";

const notebook = () => ({
  nbformat: 4,
  nbformat_minor: 4,
  metadata: {},
  cells: [
    { cell_type: "markdown", source: ["# Lab"], metadata: {} },
    {
      cell_type: "code",
      source: "x = 1",
      metadata: {},
      outputs: [],
      execution_count: null,
    },
    {
      cell_type: "code",
      source: "x = 1",
      metadata: {},
      outputs: [],
      execution_count: null,
    },
  ],
});

function importedIds(ipynb: any): string[] {
  const importer = new IPynbImporter();
  importer.import({
    ipynb,
    existing_ids: [],
    new_id: () => `random-${Math.random()}`,
  });
  const ids = Object.keys(importer.cells()).sort();
  importer.close();
  return ids;
}

describe("withDeterministicCellIds", () => {
  it("gives cells without ids the same ids in every client", () => {
    const a = withDeterministicCellIds(notebook()).cells.map((c) => c.id);
    const b = withDeterministicCellIds(notebook()).cells.map((c) => c.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3); // identical cells still get distinct ids
  });

  it("keeps ids that are in the file", () => {
    const ipynb: any = notebook();
    ipynb.cells[1].id = "from-file";
    const ids = withDeterministicCellIds(ipynb).cells.map((c: any) => c.id);
    expect(ids[1]).toBe("from-file");
    expect(new Set(ids).size).toBe(3);
  });

  it("gives a repeated file id's later cells deterministic ids", () => {
    const withDuplicates = () => {
      const ipynb: any = notebook();
      ipynb.cells.forEach((cell: any) => (cell.id = "same"));
      return ipynb;
    };
    const a = withDeterministicCellIds(withDuplicates());
    const b = withDeterministicCellIds(withDuplicates());
    expect(a.cells[0].id).toBe("same");
    expect(new Set(a.cells.map((c: any) => c.id)).size).toBe(3);
    expect(importedIds(a)).toEqual(importedIds(b));
    // Without it, the importer gives the repeats random ids.
    expect(importedIds(withDuplicates())).not.toEqual(
      importedIds(withDuplicates()),
    );
  });

  it("returns the notebook unchanged when every cell has an id", () => {
    const ipynb: any = notebook();
    ipynb.cells.forEach((cell: any, i: number) => (cell.id = `id${i}`));
    expect(withDeterministicCellIds(ipynb)).toBe(ipynb);
  });

  it("gives the default cell of a file without cells a deterministic id", () => {
    for (const empty of [{ cells: [] }, { metadata: {} }]) {
      const a = withDeterministicCellIds(deep_copy(empty));
      const b = withDeterministicCellIds(deep_copy(empty));
      expect(a.cells).toHaveLength(1);
      expect(a.cells[0].id).toBe(b.cells[0].id);
      expect(importedIds(a)).toEqual(importedIds(b));
    }
  });

  it("makes two clients' imports of the same file write the same cells", () => {
    // Without it, each client's import gets random ids: two copies of every
    // cell once both are merged.
    expect(importedIds(notebook())).not.toEqual(importedIds(notebook()));
    expect(importedIds(withDeterministicCellIds(notebook()))).toEqual(
      importedIds(withDeterministicCellIds(notebook())),
    );
  });
});
