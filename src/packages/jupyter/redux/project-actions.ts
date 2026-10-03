/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
project-actions: additional actions that are only available in the
backend/project, which "manages" everything.

This code should not *explicitly* require anything that is only
available in the project or requires node to run, so that we can
fully unit test it via mocking of components.

NOTE: this is also used by project-host processes.
*/

import { JupyterActions as JupyterActions0 } from "@cocalc/jupyter/redux/actions";
import { kernel as createJupyterKernel } from "@cocalc/jupyter/kernel";
import { getLogger } from "@cocalc/backend/logger";
import { uuid } from "@cocalc/util/misc";
import callHub from "@cocalc/conat/hub/call-hub";
import {
  embedCoCalcBlobImages,
  externalizeJupyterAttachments,
} from "@cocalc/jupyter/ipynb/blob-attachments";
import handleNbconvertChange from "./handle-nbconvert-change";

const logger = getLogger("jupyter:project-actions");

// How long the kernel must hold "running" before a previous error is cleared.
const CLEAR_KERNEL_ERROR_MS = 3000;

function isFilesystemJupyterUnsupported(err: unknown): boolean {
  const code = `${(err as any)?.code ?? ""}`.toUpperCase();
  const message = `${err instanceof Error ? err.message : err}`.toLowerCase();
  return (
    code === "ENOSYS" ||
    message.includes("unknown service method") ||
    message.includes("not implemented")
  );
}

export class JupyterActions extends JupyterActions0 {
  private clearKernelErrorTimeout?: ReturnType<typeof setTimeout>;

  protected init2(): void {
    this.initIpywidgetsSupport();
  }

  save_ipynb_file = async (_opts?) => {
    const ipynb = await this.toIpynb();
    if (ipynb == null) {
      throw Error("notebook is not loaded");
    }
    const saveIpynb = this.syncdb.fs.jupyterSaveIpynb;
    if (typeof saveIpynb === "function") {
      try {
        const result = await saveIpynb(this.path, ipynb);
        this.recordIpynbSave(result);
        if (result.converted) {
          await this.setToIpynb(result.ipynb);
        }
        return;
      } catch (err) {
        if (!isFilesystemJupyterUnsupported(err)) {
          throw err;
        }
      }
    }
    let previousIpynb: any;
    try {
      const raw = await this.syncdb.fs.readFile(this.path);
      previousIpynb = JSON.parse(
        Buffer.isBuffer(raw) ? raw.toString("utf8") : `${raw}`,
      );
    } catch {
      // The previous file is only an attachment-byte cache. A missing,
      // unreadable, or malformed file does not prevent a complete new save.
    }
    const portableIpynb = await embedCoCalcBlobImages({
      ipynb,
      previousIpynb,
      loadBlob: async (blobUuid) => await this.loadGlobalBlob(blobUuid),
    });
    await this.syncdb.fs.writeFile(
      this.path,
      JSON.stringify(portableIpynb, undefined, 2),
      true,
    );
  };

  protected override async prepareIpynbForSyncdoc(ipynb: any): Promise<any> {
    const importIpynb = this.syncdb.fs.jupyterImportIpynb;
    if (typeof importIpynb === "function") {
      try {
        return (await importIpynb(ipynb)).ipynb;
      } catch (err) {
        if (!isFilesystemJupyterUnsupported(err)) {
          throw err;
        }
      }
    }
    return await externalizeJupyterAttachments({
      ipynb,
      loadBlob: async (blobUuid) => await this.loadGlobalBlob(blobUuid),
      saveBlob: async ({ bytes, content_id, filename }) => {
        const { uuid: savedUuid } = await callHub({
          client: this.requireConatClient("saveJupyterAttachment"),
          project_id: this.project_id,
          name: "db.saveBlob",
          args: [
            {
              project_id: this.project_id,
              uuid: content_id,
              blob: bytes.toString("base64"),
            },
          ],
          timeout: 60_000,
        });
        return {
          uuid: savedUuid,
          url: `/blobs/${encodeURIComponent(filename)}?uuid=${savedUuid}`,
        };
      },
    });
  }

  private async loadGlobalBlob(
    blobUuid: string,
  ): Promise<{ bytes: Buffer } | undefined> {
    const result = await callHub({
      client: this.requireConatClient("loadJupyterAttachment"),
      project_id: this.project_id,
      name: "db.getBlob",
      args: [{ project_id: this.project_id, uuid: blobUuid }],
      timeout: 60_000,
    });
    if (result?.blob == null) {
      return;
    }
    return { bytes: Buffer.from(result.blob, "base64") };
  }

  ensureKernelIsReady = () => {
    const kernel = this.store.get("kernel");
    if (this.jupyter_kernel != null) {
      if (this.jupyter_kernel.isClosed()) {
        delete this.jupyter_kernel;
      } else if (this.jupyter_kernel.name !== kernel) {
        this.jupyter_kernel.close();
        delete this.jupyter_kernel;
      } else {
        return;
      }
    }
    logger.debug("initKernel", { kernel, path: this.path });
    // No kernel wrapper object setup at all. Make one.
    this.jupyter_kernel = createJupyterKernel({
      name: kernel,
      path: this.path,
      actions: this,
    });
    // Save the failure so it reaches the frontend and is surfaced to the user:
    // https://github.com/sagemathinc/cocalc/issues/4847
    this.jupyter_kernel.on("kernel_error", this.handleKernelError);
    this.jupyter_kernel.on("state", this.handleKernelBackendState);
  };

  private handleKernelError = (error: string): void => {
    this.set_kernel_error(error);
  };

  // A kernel that fails and then comes back should not leave its warning up,
  // so clear the error once it has held "running" for a while.  Any other
  // transition cancels the pending clear.
  private handleKernelBackendState = (state: string): void => {
    if (this.clearKernelErrorTimeout != null) {
      clearTimeout(this.clearKernelErrorTimeout);
      delete this.clearKernelErrorTimeout;
    }
    if (state != "running" || this.is_closed()) {
      return;
    }
    this.clearKernelErrorTimeout = setTimeout(() => {
      delete this.clearKernelErrorTimeout;
      if (this.is_closed()) {
        return;
      }
      this.set_runtime_settings({ kernel_error: "" });
    }, CLEAR_KERNEL_ERROR_MS);
  };

  public override close_project_only() {
    if (this.clearKernelErrorTimeout != null) {
      clearTimeout(this.clearKernelErrorTimeout);
      delete this.clearKernelErrorTimeout;
    }
  }

  override ensure_backend_kernel_setup(): void {
    this.ensureKernelIsReady();
  }

  // not actually async...
  signal = async (signal = "SIGINT"): Promise<void> => {
    this.jupyter_kernel?.signal(signal);
  };

  protected handleCellDeleted(id: string): void {
    this.jupyter_kernel?.cancel_execute(id);
  }

  handle_nbconvert_change = (oldVal, newVal): void => {
    const oldValue = oldVal?.toJS != null ? oldVal.toJS() : oldVal;
    const newValue = newVal?.toJS != null ? newVal.toJS() : newVal;
    void handleNbconvertChange(this, oldValue, newValue).catch((err) =>
      logger.debug("handle_nbconvert_change error", err),
    );
  };

  ///////////////////////////
  // Jupyter Widgets Support
  ///////////////////////////
  private initIpywidgetsSupport = () => {
    if (this.syncdb.ipywidgets_state == null) {
      logger.debug(
        "initIpywidgetsSupport: NOT WORKING -- ipywidgets_state not defined",
      );
      throw Error(
        `syncdb's ipywidgets_state must be defined! -- initIpywidgetsSupport ${this.syncdb.path}`,
      );
    }
    this.syncdb.ipywidgets_state.on(
      "change",
      this.handle_ipywidgets_state_change,
    );
    logger.debug("initIpywidgetsSupport: initialized -- on change");
  };

  capture_output_message = (mesg: any): boolean => {
    if (this.syncdb.ipywidgets_state == null) {
      throw Error(
        "syncdb's ipywidgets_state must be defined! -- capture_output_message",
      );
    }
    return this.syncdb.ipywidgets_state.capture_output_message(mesg);
  };

  process_comm_message_from_kernel = async (mesg: any): Promise<void> => {
    logger.debug("process_comm_message_from_kernel", mesg.header);
    if (this.syncdb.ipywidgets_state == null) {
      throw Error(
        "syncdb's ipywidgets_state must be defined! -- process_comm_message_from_kernel",
      );
    }
    await this.syncdb.ipywidgets_state.process_comm_message_from_kernel(mesg);
  };

  // handle_ipywidgets_state_change is called when the project ipywidgets_state
  // object changes, e.g., in response to a user moving a slider in the browser.
  // It crafts a comm message that is sent to the running Jupyter kernel telling
  // it about this change by calling sendCommMessageToKernel.
  private handle_ipywidgets_state_change = (keys): void => {
    if (this.isClosed()) {
      return;
    }
    logger.debug("handle_ipywidgets_state_change", keys);
    if (this.jupyter_kernel == null) {
      logger.debug(
        "handle_ipywidgets_state_change: no kernel, so ignoring changes to ipywidgets",
      );
      return;
    }
    if (this.syncdb.ipywidgets_state == null) {
      throw Error(
        "syncdb's ipywidgets_state must be defined! -- handle_ipywidgets_state_change",
      );
    }
    for (const key of keys) {
      const [, model_id, type] = JSON.parse(key);
      let data: any;
      if (type === "value") {
        const state = this.syncdb.ipywidgets_state.get_model_value(model_id);
        // Saving the buffers on change is critical since otherwise this breaks:
        //  https://ipywidgets.readthedocs.io/en/latest/examples/Widget%20List.html#file-upload
        // Note that stupidly the buffer (e.g., image upload) gets sent to the kernel twice.
        // But it does work robustly, and the kernel and nodejs server processes next to each
        // other so this isn't so bad.
        const { buffer_paths, buffers } =
          this.syncdb.ipywidgets_state.getKnownBuffers(model_id);
        data = { method: "update", state, buffer_paths };
        this.jupyter_kernel.sendCommMessageToKernel({
          msg_id: uuid(),
          target_name: "jupyter.widget",
          comm_id: model_id,
          data,
          buffers,
        });
      } else if (type === "buffers") {
        // TODO: we MIGHT need implement this... but MAYBE NOT.  An example where this seems like it might be
        // required is by the file upload widget, but actually that just uses the value type above, since
        // we explicitly fill in the widgets there; also there is an explicit comm upload message that
        // the widget sends out that updates the buffer, and in sendCommMessageToKernel in jupyter/kernel/kernel.ts
        // when processing that message, we saves those buffers and make sure they are set in the
        // value case above (otherwise they would get removed).
        //    https://ipywidgets.readthedocs.io/en/latest/examples/Widget%20List.html#file-upload
        // which creates a buffer from the content of the file, then sends it to the backend,
        // which sees a change and has to write that buffer to the kernel (here) so that
        // the running python process can actually do something with the file contents (e.g.,
        // process data, save file to disk, etc).
        // We need to be careful though to not send buffers to the kernel that the kernel sent us,
        // since that would be a waste.
      } else if (type === "state") {
        // TODO: currently ignoring this, since it seems chatty and pointless,
        // and could lead to race conditions probably with multiple users, etc.
        // It happens right when the widget is created.
        /*
        const state = this.syncdb.ipywidgets_state.getModelSerializedState(model_id);
        data = { method: "update", state };
        this.jupyter_kernel.sendCommMessageToKernel(
          misc.uuid(),
          model_id,
          data
        );
        */
      } else {
        const m = `Jupyter: unknown type '${type}'`;
        console.warn(m);
        logger.debug("WARNING: ", m);
      }
    }
  };
}
