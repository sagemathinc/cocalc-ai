/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// nbformat allows null values in cell and notebook metadata. A metadata edit
// must keep them, in this document and on every peer applying the edit's
// patch, such as the backend that saves the .ipynb (#1388).

import { Map as ImmutableMap } from "immutable";
import { fromString } from "patchflow";
import { IPynbImporter } from "../ipynb/import-from-ipynb";
import { JupyterActions } from "../redux/actions";
import { SYNCDB_OPTIONS } from "../redux/sync";

const IPYNB = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: {
      name: "python3",
      display_name: "Python 3",
      language: "python",
    },
    my_flag: null,
  },
  cells: [
    {
      cell_type: "code",
      id: "a",
      execution_count: null,
      outputs: [],
      source: "1+1",
      metadata: { keep_me: null, other: 1 },
    },
  ],
};

const PRIMARY_KEYS = new Set<string>(SYNCDB_OPTIONS.primary_keys);
const STRING_COLS = new Set<string>(SYNCDB_OPTIONS.string_cols);

// The imported notebook as a document, and a JupyterActions whose syncdb and
// store are that document (as SyncDB and the store reflect it).
function openNotebook() {
  const importer = new IPynbImporter();
  importer.import({ ipynb: IPYNB });
  const records = [
    ...Object.values(importer.cells()),
    { type: "settings", metadata: importer.metadata() },
  ];
  importer.close();
  const base = fromString(
    records.map((r) => JSON.stringify(r)).join("\n"),
    PRIMARY_KEYS,
    STRING_COLS,
  );
  const state = { doc: base };
  const actions = Object.create(JupyterActions.prototype);
  Object.assign(actions, {
    _state: "ready",
    syncdb: {
      isReady: () => true,
      get_one: (where) => state.doc.getOne(where),
      set: (obj) => {
        state.doc = state.doc.set(obj);
      },
      commit: () => {},
    },
    store: {
      get: () => undefined,
      getIn: ([kind, id, ...rest], dflt) => {
        if (kind !== "cells") return dflt;
        return state.doc.getOne({ type: "cell", id })?.getIn(rest) ?? dflt;
      },
    },
    _set: (obj) => {
      state.doc = state.doc.set(obj);
    },
    check_edit_protection: () => false,
    add_tag: () => {},
    edit_cell_metadata: () => {},
    save_asap: () => {},
  });
  return { actions, base, state };
}

const cellMetadata = (doc) =>
  doc.getOne({ type: "cell", id: "a" })?.get("metadata")?.toJS();
const notebookMetadata = (doc) =>
  doc.getOne({ type: "settings" })?.get("metadata")?.toJS();

// what a peer that has the notebook ends up with after the edit's patch
const onPeer = (base, doc) =>
  fromString(base.toString(), PRIMARY_KEYS, STRING_COLS).applyPatch(
    base.makePatch(doc),
  );

it("imports null-valued metadata keys", () => {
  const { base } = openNotebook();
  expect(cellMetadata(base)).toEqual({ keep_me: null, other: 1 });
  expect(notebookMetadata(base)).toMatchObject({ my_flag: null });
});

it("keeps a cell's null-valued metadata key when hiding its input", () => {
  const { actions, base, state } = openNotebook();
  actions.toggle_jupyter_metadata_boolean("a", "source_hidden");
  const expected = {
    keep_me: null,
    other: 1,
    jupyter: { source_hidden: true },
  };
  expect(cellMetadata(state.doc)).toEqual(expected);
  expect(cellMetadata(onPeer(base, state.doc))).toEqual(expected);
});

it("keeps the notebook's null-valued metadata key when changing the output limit", () => {
  const { actions, base, state } = openNotebook();
  actions.set_output_limit_bytes(4 * 1024 * 1024);
  for (const doc of [state.doc, onPeer(base, state.doc)]) {
    const metadata = notebookMetadata(doc);
    expect(metadata).toMatchObject({
      my_flag: null,
      cocalc: { output_limit_bytes: 4 * 1024 * 1024 },
    });
  }
});

it("still deletes a metadata key set to null", () => {
  const { actions, base, state } = openNotebook();
  actions.set_cell_metadata({
    id: "a",
    metadata: { other: null },
    merge: true,
  });
  for (const doc of [state.doc, onPeer(base, state.doc)]) {
    expect(cellMetadata(doc)).toEqual({ keep_me: null });
  }
  // and a notebook metadata key
  actions.set_global_metadata({ my_flag: null });
  expect(notebookMetadata(state.doc)).not.toHaveProperty("my_flag");
  expect(
    ImmutableMap.isMap(state.doc.getOne({ type: "settings" })?.get("metadata")),
  ).toBe(true);
});
