/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uuidsha1 } from "@cocalc/backend/misc_node";
import { JupyterActions } from "./project-actions";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const blobUuid = uuidsha1(png);

function createActions(ipynb: any, loadResult?: { bytes: Buffer }) {
  const writeFile = jest.fn(async () => {});
  const actions = new JupyterActions("test", {} as any) as any;
  actions.path = "portable.ipynb";
  actions.toIpynb = jest.fn(async () => ipynb);
  actions.loadGlobalBlob = jest.fn(async () => loadResult);
  actions.syncdb = {
    fs: {
      readFile: jest.fn(async () => {
        const error: any = new Error("not found");
        error.code = "ENOENT";
        throw error;
      }),
      writeFile,
    },
  };
  return { actions, writeFile };
}

describe("project-side portable ipynb save", () => {
  it("preserves an authored image URL when its blob is unavailable", async () => {
    const source = `![lost](/blobs/lost.png?uuid=${blobUuid})`;
    const { actions, writeFile } = createActions({
      cells: [
        {
          cell_type: "markdown",
          metadata: {},
          source,
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    });

    await actions.save_ipynb_file();

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [, raw, saveLast] = writeFile.mock.calls[0];
    const saved = JSON.parse(raw);
    expect(saved.cells[0].source).toBe(source);
    expect(saved.cells[0].attachments).toBeUndefined();
    expect(saveLast).toBe(true);
  });

  it("writes a native attachment only after conversion succeeds", async () => {
    const { actions, writeFile } = createActions(
      {
        cells: [
          {
            cell_type: "markdown",
            metadata: {},
            source: `![image](/blobs/image.png?uuid=${blobUuid})`,
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      },
      { bytes: png },
    );

    await actions.save_ipynb_file();

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [, raw, saveLast] = writeFile.mock.calls[0];
    const saved = JSON.parse(raw);
    expect(saved.cells[0].source).toBe("![image](attachment:image.png)");
    expect(saved.cells[0].attachments["image.png"]["image/png"]).toBe(
      png.toString("base64"),
    );
    expect(saveLast).toBe(true);
  });
});

// Support ticket 21023: the project-side save (nbconvert, the Jupyter API)
// must not write the generated empty cell over a notebook file with content.
describe("project-side save of the generated placeholder", () => {
  const { List, fromJS } = require("immutable");
  const { export_to_ipynb } = require("../ipynb/export-to-ipynb");
  const ALPHA = { type: "cell", id: "alpha", pos: 0, input: "" };
  const LAB_TEXT = JSON.stringify({
    cells: [{ cell_type: "markdown", source: ["### Lab 3"], metadata: {} }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });

  function placeholderActions({
    disk,
    settings = {},
    cells = [ALPHA],
  }: {
    disk?: string;
    settings?: object;
    cells?: object[];
  }) {
    const exported = export_to_ipynb({
      cell_list: ["alpha"],
      cells: { alpha: { ...ALPHA } },
      kernelspec: { name: "python3" },
    } as any);
    const { actions, writeFile } = createActions(exported);
    actions.syncdb.get = () => List(cells.map((cell) => fromJS(cell)));
    actions.syncdb.get_one = () => fromJS({ type: "settings", ...settings });
    if (disk != null) {
      actions.syncdb.fs.readFile = jest.fn(async () => Buffer.from(disk));
    }
    return { actions, writeFile };
  }

  it("does not write the placeholder over a file with content", async () => {
    const { actions, writeFile } = placeholderActions({ disk: LAB_TEXT });
    await actions.save_ipynb_file();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("does not write over a file it cannot parse (e.g. still being copied)", async () => {
    const { actions, writeFile } = placeholderActions({
      disk: LAB_TEXT.slice(0, 20),
    });
    await actions.save_ipynb_file();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("never writes the placeholder, even when the file looks empty", async () => {
    // Checking the file first is not enough: a course copy can fill it in
    // between that read and the write.
    for (const disk of [undefined, ""]) {
      const { actions, writeFile } = placeholderActions({ disk });
      await actions.save_ipynb_file();
      expect(writeFile).not.toHaveBeenCalled();
    }
  });

  it("does not write a notebook with no cells yet over a file with content", async () => {
    const { actions, writeFile } = placeholderActions({
      disk: LAB_TEXT,
      cells: [],
    });
    actions.toIpynb = jest.fn(async () => ({ cells: [], metadata: {} }));
    await actions.save_ipynb_file();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes a notebook emptied through the API or CLI", async () => {
    // A real cell when the actions load; then every cell is deleted (e.g.
    // `project jupyter delete-cells`) and the notebook is saved.
    const { actions, writeFile } = placeholderActions({
      disk: LAB_TEXT,
      cells: [{ ...ALPHA, input: "x = 1" }],
    });
    actions.syncdb.set = jest.fn();
    actions.syncdb.commit = jest.fn();
    actions.syncdb.save = jest.fn(async () => {});
    actions.syncdb.get_state = () => "ready";
    actions.store = { get: () => undefined };
    actions.__syncdb_change_post_hook(true);
    actions.syncdb.get = () => List();
    actions.toIpynb = jest.fn(async () => ({ cells: [], metadata: {} }));
    actions.__syncdb_change_post_hook(false);

    await actions.save_ipynb_file();

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(actions.syncdb.set).toHaveBeenCalledWith(
      expect.objectContaining({ type: "settings", has_had_content: true }),
    );
  });

  it("writes a notebook that was emptied on purpose", async () => {
    const { actions, writeFile } = placeholderActions({
      disk: LAB_TEXT,
      settings: { has_had_content: true },
    });
    await actions.save_ipynb_file();
    expect(writeFile).toHaveBeenCalledTimes(1);
  });
});

// The project-side save writes one consistent snapshot, retrying from a fresh
// one when the notebook changes while it is taken, written or applied.
describe("project-side save of a changing notebook", () => {
  const { List, fromJS } = require("immutable");
  const { export_to_ipynb } = require("../ipynb/export-to-ipynb");

  function liveActions() {
    let version = "v1";
    let input = "";
    const exportNow = () =>
      export_to_ipynb({
        cell_list: ["alpha"],
        cells: { alpha: { type: "cell", id: "alpha", pos: 0, input } },
        kernelspec: { name: "python3" },
      } as any);
    const { actions } = createActions(undefined);
    actions.syncdb.get = () =>
      List([fromJS({ type: "cell", id: "alpha", pos: 0, input })]);
    actions.syncdb.get_one = () => fromJS({ type: "settings" });
    actions.syncdb.newestVersion = () => version;
    const edit = (next: string, v: string) => {
      input = next;
      version = v;
    };
    actions.toIpynb = jest.fn(async () => exportNow());
    const saved: string[] = [];
    actions.syncdb.fs.jupyterSaveIpynb = jest.fn(async (_path, ipynb) => {
      saved.push(ipynb.cells[0].source.join(""));
      return { bytes: 10, converted: false, ipynb };
    });
    actions.recordIpynbSave = jest.fn();
    return { actions, edit, saved };
  }

  it("does not write a blank snapshot taken just before the notebook changed", async () => {
    const { actions, edit, saved } = liveActions();
    const snapshot = actions.toIpynb;
    actions.toIpynb = jest.fn(async () => {
      const ipynb = await snapshot();
      if (saved.length === 0 && actions.toIpynb.mock.calls.length === 1) {
        edit("answer = 42", "v2"); // typed while the snapshot was taken
      }
      return ipynb;
    });

    await actions.save_ipynb_file();

    expect(saved).toEqual(["answer = 42"]);
  });

  it("saves again when the notebook changes during the write", async () => {
    const { actions, edit, saved } = liveActions();
    edit("x = 1", "v1");
    const write = actions.syncdb.fs.jupyterSaveIpynb;
    actions.syncdb.fs.jupyterSaveIpynb = jest.fn(async (path, ipynb) => {
      const result = await write(path, ipynb);
      if (saved.length === 1) edit("x = 2", "v2");
      return result;
    });

    await actions.save_ipynb_file();

    expect(saved).toEqual(["x = 1", "x = 2"]);
  });

  it("saves again when the notebook changes while a conversion is applied", async () => {
    const { actions, edit, saved } = liveActions();
    edit("x = 1", "v1");
    actions.syncdb.fs.jupyterSaveIpynb = jest.fn(async (_path, ipynb) => {
      saved.push(ipynb.cells[0].source.join(""));
      return { bytes: 10, converted: saved.length === 1, ipynb };
    });
    actions.setToIpynb = jest.fn(async () => {
      edit("x = 1", "imported");
      actions.noteImportCommit();
      edit("x = 3", "v3"); // edited before the apply finished
    });

    await actions.save_ipynb_file();

    expect(saved).toEqual(["x = 1", "x = 3"]);
  });
});
