/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  Filesystem,
  JupyterImportIpynbResult,
  JupyterSaveIpynbResult,
} from "@cocalc/conat/files/fs";
import {
  importJupyterIpynb as importFilesystemJupyterIpynb,
  MAX_JUPYTER_IPYNB_CELLS,
  MAX_JUPYTER_IPYNB_RPC_BYTES,
  saveJupyterIpynb as saveFilesystemJupyterIpynb,
  type JupyterFilesystemBlobStore,
} from "@cocalc/jupyter/ipynb/filesystem";
import { hubApi } from "@cocalc/lite/hub/api";

export { MAX_JUPYTER_IPYNB_CELLS, MAX_JUPYTER_IPYNB_RPC_BYTES };

const blobStore: JupyterFilesystemBlobStore = {
  async loadBlob({ project_id, uuid }) {
    const result = await hubApi.db.getBlob({ project_id, uuid });
    if (result?.blob == null) return;
    return { bytes: Buffer.from(result.blob, "base64") };
  },

  async saveBlob({ project_id, bytes, content_id, filename }) {
    const { uuid } = await hubApi.db.saveBlob({
      project_id,
      uuid: content_id,
      blob: bytes.toString("base64"),
    });
    return {
      uuid,
      url: `/blobs/${encodeURIComponent(filename)}?uuid=${uuid}`,
    };
  },
};

export async function importJupyterIpynb({
  project_id,
  ipynb,
}: {
  project_id: string;
  ipynb: object;
}): Promise<JupyterImportIpynbResult> {
  return await importFilesystemJupyterIpynb({
    project_id,
    ipynb,
    blobStore,
  });
}

export async function saveJupyterIpynb({
  project_id,
  path,
  ipynb,
  fs,
}: {
  project_id: string;
  path: string;
  ipynb: object;
  fs: Filesystem;
}): Promise<JupyterSaveIpynbResult> {
  return await saveFilesystemJupyterIpynb({
    project_id,
    path,
    ipynb,
    fs,
    blobStore,
  });
}
