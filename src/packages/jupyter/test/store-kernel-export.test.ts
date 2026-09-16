import { fromJS } from "immutable";
import { JupyterStore } from "../redux/store";
import { IPynbImporter } from "../ipynb/import-from-ipynb";

function makeStore(kernel: string | undefined, kernels?: unknown) {
  const state = fromJS({
    notebook: {
      kernel,
      kernels,
      cells: {},
      cell_list: [],
      metadata: { language_info: { name: "python" } },
    },
  });
  return new JupyterStore("notebook", {
    reduxStore: { getState: () => state },
  } as any);
}

describe("notebook kernel selection export", () => {
  it.each([undefined, null, [], [{ name: "python3", display_name: "Python" }]])(
    "retains a remote selection when catalog metadata is unavailable (%p)",
    (kernels) => {
      const store = makeStore("reflect-student-gpu", kernels);
      const notebook = store.get_ipynb();
      expect(notebook.metadata.kernelspec.name).toBe("reflect-student-gpu");
      const importer = new IPynbImporter();
      try {
        importer.import({ ipynb: notebook });
        expect(importer.kernel()).toBe("reflect-student-gpu");
      } finally {
        importer.close();
      }
    },
  );

  it("preserves known display and language metadata", () => {
    const spec = {
      name: "python3",
      display_name: "Python 3",
      language: "python",
    };
    expect(
      makeStore("python3", [spec]).get_ipynb().metadata.kernelspec,
    ).toEqual(spec);
  });

  it.each(["", undefined])(
    "does not restore an explicitly absent kernel (%p)",
    (kernel) => {
      expect(makeStore(kernel, null).get_ipynb().metadata.kernelspec).toEqual(
        {},
      );
    },
  );
});
