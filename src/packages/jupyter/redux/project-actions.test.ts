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
  }: {
    disk?: string;
    settings?: object;
  }) {
    const exported = export_to_ipynb({
      cell_list: ["alpha"],
      cells: { alpha: { ...ALPHA } },
      kernelspec: { name: "python3" },
    } as any);
    const { actions, writeFile } = createActions(exported);
    actions.syncdb.get = () => List([fromJS(ALPHA)]);
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

  it("writes the placeholder when there is no file", async () => {
    const { actions, writeFile } = placeholderActions({});
    await actions.save_ipynb_file();
    expect(writeFile).toHaveBeenCalledTimes(1);
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
