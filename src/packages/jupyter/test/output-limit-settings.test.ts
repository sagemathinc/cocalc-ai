import { fromJS } from "immutable";
import { JupyterActions } from "../redux/actions";
import { IPynbImporter } from "../ipynb/import-from-ipynb";

it("preserves sibling notebook metadata when changing the output limit", () => {
  const metadata = { other: "keep", cocalc: { other_setting: 7 } };
  const settings = { type: "settings", metadata };
  const actions = {
    syncdb: { get_one: () => fromJS(settings) },
    set_global_metadata: jest.fn(),
  };
  JupyterActions.prototype.set_output_limit_bytes.call(
    actions,
    4 * 1024 * 1024,
  );
  expect(actions.set_global_metadata).toHaveBeenCalledWith({
    cocalc: { other_setting: 7, output_limit_bytes: 4 * 1024 * 1024 },
  });
});

it("reads the setting from immutable metadata, including imported ipynb metadata", () => {
  const importer = new IPynbImporter();
  importer.import({
    ipynb: {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [],
      metadata: { cocalc: { output_limit_bytes: 16 * 1024 * 1024 } },
    },
  });
  const actions = { store: fromJS({ metadata: importer.metadata() }) };
  expect(JupyterActions.prototype.get_output_limit_bytes.call(actions)).toBe(
    16 * 1024 * 1024,
  );
  importer.close();
});
