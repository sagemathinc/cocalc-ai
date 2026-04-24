import { SyncDB } from "@cocalc/sync/editor/db/sync";
import { SYNCDB_OPTIONS } from "@cocalc/jupyter/redux/sync";
import { type Filesystem } from "@cocalc/conat/files/fs";
import { initJupyterRedux, removeJupyterRedux } from "@cocalc/jupyter/kernel";
import { get_kernel_data } from "@cocalc/jupyter/kernel/kernel-data";
import type { Kernels } from "@cocalc/jupyter/util/misc";
import { syncdbPath, ipynbPath } from "@cocalc/util/jupyter/names";
import { once } from "@cocalc/util/async-utils";
import { OutputHandler } from "@cocalc/jupyter/execute/output-handler";
import { get_kernels_by_name_or_language } from "@cocalc/jupyter/util/misc";
import {
  readFile as readFileAbsolute,
  realpath as realpathAbsolute,
  stat as statAbsolute,
  writeFile as writeFileAbsolute,
} from "node:fs/promises";
import { relative, resolve } from "node:path";
import { throttle } from "lodash";
import { fromJS } from "immutable";
import { type RunOptions } from "@cocalc/conat/project/jupyter/run-code";
import type {
  ExpectedJupyterCell,
  JupyterSaveOptions,
} from "@cocalc/conat/project/api/jupyter";
import { type JupyterActions } from "@cocalc/jupyter/redux/project-actions";
import { bufferToBase64 } from "@cocalc/util/base64";
import { getLogger } from "@cocalc/backend/logger";

const logger = getLogger("jupyter:control");

const jupyterActions: { [ipynbPath: string]: JupyterActions } = {};

function isAbsolutePath(path: string): boolean {
  return typeof path === "string" && path.startsWith("/");
}

export function createJupyterSyncFilesystem(fs: Filesystem): Filesystem {
  if ((fs as any)?.unsafeMode !== true) {
    return fs;
  }
  const sandboxHome =
    typeof (fs as any)?.path === "string" ? resolve((fs as any).path) : null;
  const rewriteProjectHomePath = (path: string): string | null => {
    if (!isAbsolutePath(path) || sandboxHome == null) {
      return null;
    }
    if (path === sandboxHome || path.startsWith(`${sandboxHome}/`)) {
      return relative(sandboxHome, path);
    }
    return null;
  };
  const useDirectAbsolutePath = (path: string): boolean => {
    return isAbsolutePath(path) && rewriteProjectHomePath(path) == null;
  };
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (
        prop === "canonicalSyncIdentityPath" ||
        prop === "canonicalSyncFsPath"
      ) {
        return async (path: string) => {
          if (isAbsolutePath(path)) {
            return path;
          }
          const fn = Reflect.get(target, prop, receiver);
          if (typeof fn === "function") {
            return await fn.call(target, path);
          }
          return path;
        };
      }
      if (prop === "readFile") {
        return async (path: string, encoding?: string, lock?: number) => {
          const rewritten = rewriteProjectHomePath(path);
          if (rewritten != null) {
            return await target.readFile(rewritten, encoding, lock);
          }
          if (useDirectAbsolutePath(path) && lock == null) {
            if (encoding == null) {
              return await readFileAbsolute(path);
            }
            return await readFileAbsolute(path, {
              encoding: encoding as BufferEncoding,
            });
          }
          return await target.readFile(path, encoding, lock);
        };
      }
      if (prop === "stat") {
        return async (path: string) => {
          const rewritten = rewriteProjectHomePath(path);
          if (rewritten != null) {
            return await target.stat(rewritten);
          }
          if (useDirectAbsolutePath(path)) {
            return await statAbsolute(path);
          }
          return await target.stat(path);
        };
      }
      if (prop === "exists") {
        return async (path: string) => {
          const rewritten = rewriteProjectHomePath(path);
          if (rewritten != null) {
            return await target.exists(rewritten);
          }
          if (useDirectAbsolutePath(path)) {
            try {
              await statAbsolute(path);
              return true;
            } catch (err: any) {
              if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
                return false;
              }
              throw err;
            }
          }
          return await target.exists(path);
        };
      }
      if (prop === "realpath") {
        return async (path: string) => {
          const rewritten = rewriteProjectHomePath(path);
          if (rewritten != null) {
            const resolved = await target.realpath(rewritten);
            return isAbsolutePath(resolved)
              ? resolved
              : resolve(sandboxHome ?? "/", resolved);
          }
          if (useDirectAbsolutePath(path)) {
            return await realpathAbsolute(path);
          }
          return await target.realpath(path);
        };
      }
      if (prop === "writeFile") {
        return async (path: string, data: any, saveLast?: boolean) => {
          const rewritten = rewriteProjectHomePath(path);
          if (rewritten != null) {
            return await target.writeFile(rewritten, data, saveLast);
          }
          if (
            useDirectAbsolutePath(path) &&
            (typeof data === "string" ||
              Buffer.isBuffer(data) ||
              data instanceof Uint8Array)
          ) {
            await writeFileAbsolute(path, data);
            return;
          }
          return await target.writeFile(path, data, saveLast);
        };
      }
      if (prop === "writeFileDelta") {
        return async (
          path: string,
          content: string | Buffer,
          options?: any,
        ) => {
          const rewritten = rewriteProjectHomePath(path);
          if (rewritten != null) {
            return await target.writeFileDelta(rewritten, content, options);
          }
          if (useDirectAbsolutePath(path)) {
            await writeFileAbsolute(path, content);
            return;
          }
          return await target.writeFileDelta(path, content, options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Filesystem;
}

export async function restoreKernelFromIpynb({
  actions,
  fs,
  path,
}: {
  actions: Pick<JupyterActions, "store" | "syncdb"> & {
    setState?: (state: any) => void;
  };
  fs: Pick<Filesystem, "readFile">;
  path: string;
}): Promise<boolean> {
  const notebookPath = ipynbPath(path);
  const currentKernel = actions.store.get("kernel");
  const hasKernel = currentKernel != null && currentKernel !== "";
  if (hasKernel) {
    return false;
  }
  let raw: Buffer | Uint8Array | string;
  try {
    raw = await fs.readFile(notebookPath);
  } catch (err) {
    if (!notebookPath.startsWith("/") || (err as any)?.code !== "ENOENT") {
      throw err;
    }
    raw = await readFileAbsolute(notebookPath);
  }
  const content = Buffer.from(raw);
  if (content.length === 0) {
    return false;
  }
  const ipynb = JSON.parse(content.toString());
  const kernel = ipynb?.metadata?.kernelspec?.name;
  if (hasKernel || kernel == null || kernel === "") {
    return false;
  }
  actions.syncdb.set({ type: "settings", kernel });
  actions.syncdb.commit();
  await actions.syncdb.save();
  actions.setState?.({ kernel });
  return true;
}

export async function hydrateNotebookFromIpynbIfNeeded({
  actions,
  fs,
  path,
}: {
  actions: Pick<JupyterActions, "syncdb" | "setToIpynb">;
  fs: Pick<Filesystem, "readFile">;
  path: string;
}): Promise<boolean> {
  const existing = actions.syncdb.get({ type: "cell" });
  const existingCount =
    typeof existing?.size === "number"
      ? existing.size
      : Array.isArray(existing)
        ? existing.length
        : existing == null
          ? 0
          : 1;
  if (existingCount > 0) {
    return false;
  }
  const notebookPath = ipynbPath(path);
  let raw: Buffer | Uint8Array | string;
  try {
    raw = await fs.readFile(notebookPath);
  } catch (err) {
    if (!notebookPath.startsWith("/") || (err as any)?.code !== "ENOENT") {
      throw err;
    }
    raw = await readFileAbsolute(notebookPath);
  }
  const content = Buffer.from(raw);
  if (content.length === 0) {
    return false;
  }
  const ipynb = JSON.parse(content.toString());
  const cells = Array.isArray(ipynb?.cells) ? ipynb.cells : [];
  if (cells.length === 0) {
    return false;
  }
  await actions.setToIpynb(ipynb);
  return true;
}

export async function loadKernelSpecsIntoStore({
  actions,
}: {
  actions: Pick<JupyterActions, "store" | "setState">;
}): Promise<boolean> {
  if (actions.store.get("kernels") !== undefined) {
    return false;
  }
  const kernels = fromJS(await get_kernel_data()).filter(
    (kernel) => !kernel.getIn(["metadata", "cocalc", "disabled"], false),
  ) as Kernels;
  const [kernels_by_name, kernels_by_language] =
    get_kernels_by_name_or_language(kernels);
  const kernel_selection = actions.store.get_kernel_selection(kernels);
  const kernelName = actions.store.get("kernel");
  let kernel_info;
  kernels.forEach((kernel) => {
    if (kernel.get("name") === kernelName) {
      kernel_info = kernel.toJS();
      return false;
    }
  });
  actions.setState({
    kernels,
    kernel_info,
    kernel_selection,
    kernels_by_name,
    kernels_by_language,
    default_kernel: actions.store.get_default_kernel(),
  });
  return true;
}

export function isRunning(path): boolean {
  return jupyterActions[ipynbPath(path)] != null;
}

let project_id: string = "";

export async function start({
  path,
  project_id: project_id0,
  client,
  fs,
}: {
  path: string;
  client;
  project_id: string;
  fs: Filesystem;
}) {
  if (isRunning(path)) {
    return;
  }
  project_id = project_id0;
  logger.debug("start: ", path, " - starting it");
  const syncFs = createJupyterSyncFilesystem(fs);
  const syncdb = new SyncDB({
    ...SYNCDB_OPTIONS,
    project_id,
    path: syncdbPath(path),
    client,
    fs: syncFs,
  });
  syncdb.on("error", (err) => {
    // [ ] TODO: some way to convey this to clients (?)
    logger.debug(`syncdb error -- ${err}`, path);
    stop({ path });
  });
  syncdb.once("closed", () => {
    stop({ path });
  });
  const { actions } = initJupyterRedux(syncdb, client);
  jupyterActions[ipynbPath(path)] = actions;
  if (syncdb.get_state() === "init") {
    await once(syncdb, "ready");
  }
  if (syncdb.isClosed()) {
    return;
  }
  try {
    await hydrateNotebookFromIpynbIfNeeded({ actions, fs: syncFs, path });
    await restoreKernelFromIpynb({ actions, fs: syncFs, path });
    await loadKernelSpecsIntoStore({ actions });
  } catch (err) {
    logger.debug("start: failed to initialize kernel from disk", {
      path,
      err: `${err}`,
    });
  }
}

export function stop({ path }: { path: string }) {
  const actions = jupyterActions[ipynbPath(path)];
  if (actions == null) {
    logger.debug("stop: ", path, " - not running");
  } else {
    delete jupyterActions[ipynbPath(path)];
    const { syncdb } = actions;
    logger.debug("stop: ", path, " - stopping it");
    syncdb.close();
    removeJupyterRedux(ipynbPath(path), project_id);
  }
}

export async function getKernelStatus({ path }) {
  const actions = jupyterActions[ipynbPath(path)];
  const kernel = actions?.jupyter_kernel;
  if (kernel == null) {
    return { backend_state: "off" as "off", kernel_state: "idle" as "idle" };
  }
  return kernel.getStatus();
}

function cellSatisfiesExpected(cell: any, expected: ExpectedJupyterCell) {
  if (cell == null) {
    return false;
  }
  const plain = cell?.toJS instanceof Function ? cell.toJS() : cell;
  if (plain?.id !== expected.id) {
    return false;
  }
  if (
    expected.cell_type != null &&
    (plain?.cell_type ?? "code") !== expected.cell_type
  ) {
    return false;
  }
  if (expected.input != null && (plain?.input ?? "") !== expected.input) {
    return false;
  }
  return true;
}

async function waitForExpectedCells(
  actions: JupyterActions,
  opts: Pick<JupyterSaveOptions, "expectedCellCount" | "expectedCells">,
) {
  const expectedCells = opts.expectedCells ?? [];
  if (opts.expectedCellCount == null && expectedCells.length === 0) {
    return;
  }
  const started = Date.now();
  while (true) {
    const cells = actions.store.get("cells");
    const count = cells?.size;
    const countMatches =
      opts.expectedCellCount == null || count === opts.expectedCellCount;
    const cellsMatch = expectedCells.every((expected) =>
      cellSatisfiesExpected(cells?.get?.(expected.id), expected),
    );
    if (countMatches && cellsMatch) {
      return;
    }
    if (Date.now() - started > 2_000) {
      throw Error("timed out waiting for expected notebook cells before save");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function save(opts: JupyterSaveOptions) {
  const actions = jupyterActions[ipynbPath(opts.path)];
  if (actions == null) {
    throw Error(`${ipynbPath(opts.path)} not running`);
  }
  await waitForExpectedCells(actions, opts);
  await actions.save_ipynb_file();
}

// Returns async iterator over outputs
export async function run({ path, cells, noHalt, socket, run_id }: RunOptions) {
  logger.debug("run:", { path, noHalt, run_id });

  const actions = jupyterActions[ipynbPath(path)];
  if (actions == null) {
    throw Error(`${ipynbPath(path)} not running`);
  }
  if (actions.syncdb.isClosed()) {
    // shouldn't be possible
    throw Error("syncdb is closed");
  }
  if (!actions.syncdb.isReady()) {
    logger.debug("jupyterRun: waiting until ready");
    await once(actions.syncdb, "ready");
  }
  logger.debug("jupyterRun: running");
  async function* runCells() {
    const lifecycle = (
      type: "run_start" | "run_done" | "cell_start" | "cell_done",
      id?: string,
    ) => {
      return {
        ...(id != null ? { id } : {}),
        msg_type: type,
        lifecycle: type,
        run_id,
      };
    };
    yield lifecycle("run_start");
    try {
      for (const cell of cells) {
        yield lifecycle("cell_start", cell.id);
        actions.ensureKernelIsReady();
        const kernel = actions.jupyter_kernel!;
        const output = kernel.execute_code({
          halt_on_error: !noHalt,
          code: cell.input,
          stdin: async (prompt: string, password: boolean) => {
            try {
              const resp = await socket.request(
                {
                  type: "stdin",
                  id: cell.id,
                  prompt,
                  password,
                },
                // timeout
                { timeout: 1000 * 60 * 15 },
              );
              return resp.data;
            } catch (err) {
              return `${err}`;
            }
          },
        });
        let haltAfterCell = false;
        try {
          for await (const mesg0 of output.iter()) {
            const content = mesg0?.content;
            if (content != null) {
              // this mutates content, removing large base64/svg, etc. images, pdf's, etc.
              await actions.processOutput(content);
            }
            const mesg = { ...mesg0, id: cell.id, run_id };
            yield mesg;
            if (!noHalt && mesg.msg_type == "error") {
              // done running code because there was an error.
              haltAfterCell = true;
              break;
            }
          }
        } finally {
          yield lifecycle("cell_done", cell.id);
        }
        if (kernel.failedError) {
          // kernel failed during call
          throw Error(kernel.failedError);
        }
        if (haltAfterCell) {
          break;
        }
      }
    } finally {
      yield lifecycle("run_done");
    }
  }
  return await runCells();
}

const BACKEND_OUTPUT_FPS = 8;

export class MulticellOutputHandler {
  private id: string | null = null;
  private handler: OutputHandler | null = null;
  private flush?: () => void;
  private writeFinal?: () => void;

  constructor(
    private cells: RunOptions["cells"],
    private actions,
  ) {}

  process = (mesg) => {
    if (mesg.id !== this.id || this.handler == null) {
      this.id = mesg.id;
      let cell = this.cells[mesg.id] ?? { id: mesg.id };
      const hadStaleOutput = cell.output != null || cell.exec_count != null;
      this.handler?.done();
      this.handler = new OutputHandler({ cell });
      const writeCell = (save: boolean) => {
        const { id, state, output, start, end, exec_count } = cell;
        this.actions.set_runtime_cell_state(id, { state, start, end });
        this.actions._set({ type: "cell", id, output, exec_count }, save);
      };
      let wroteInitialState = false;
      const f = throttle(
        () => {
          writeCell(false);
        },
        1000 / BACKEND_OUTPUT_FPS,
        {
          leading: true,
          trailing: true,
        },
      );
      this.flush = () => f.flush();
      this.writeFinal = () => writeCell(true);
      this.handler.on("change", () => {
        if (!wroteInitialState) {
          wroteInitialState = true;
          writeCell(true);
          if (hadStaleOutput) {
            void this.actions.save_asap?.();
          }
          return;
        }
        f();
      });
      this.handler.on("done", () => {
        this.flush?.();
        this.writeFinal?.();
      });
      this.handler.on("process", this.actions.processOutput);
    }
    this.handler!.process(mesg);
  };

  done = () => {
    this.flush?.();
    this.handler?.done();
    this.handler = null;
    this.flush = undefined;
    this.writeFinal = undefined;
  };
}

export function outputHandler({ path, cells }: RunOptions) {
  if (jupyterActions[ipynbPath(path)] == null) {
    throw Error(`session '${ipynbPath(path)}' not available`);
  }
  const actions = jupyterActions[ipynbPath(path)];
  return new MulticellOutputHandler(cells, actions);
}

function getKernel(path: string) {
  const actions = jupyterActions[ipynbPath(path)];
  if (actions == null) {
    throw Error(`${ipynbPath(path)} not running`);
  }
  actions.ensureKernelIsReady();
  return actions.jupyter_kernel!;
}

export async function introspect(opts: {
  path: string;
  code: string;
  cursor_pos: number;
  detail_level: 0 | 1;
}) {
  const kernel = getKernel(opts.path);
  return await kernel.introspect(opts);
}

export async function complete(opts: {
  path: string;
  code: string;
  cursor_pos: number;
}) {
  const kernel = getKernel(opts.path);
  return await kernel.complete(opts);
}

export async function getConnectionFile(opts: { path }) {
  const kernel = getKernel(opts.path);
  await kernel.ensureRunning();
  const c = kernel.getConnectionFile();
  if (c == null) {
    throw Error("unable to start kernel");
  }
  return c;
}

export async function signal(opts: { path: string; signal: string }) {
  const kernel = getKernel(opts.path);
  await kernel.signal(opts.signal);
}

export async function sendCommMessageToKernel({ path, msg }) {
  const kernel = getKernel(path);
  await kernel.sendCommMessageToKernel(msg);
}

export async function ipywidgetsGetBuffer({ path, model_id, buffer_path }) {
  const kernel = getKernel(path);
  const buffer = kernel.ipywidgetsGetBuffer(model_id, buffer_path);
  if (buffer == null) {
    throw Error(
      `no buffer for model=${model_id}, buffer_path=${JSON.stringify(
        buffer_path,
      )}`,
    );
  }
  return { buffer64: bufferToBase64(buffer) };
}
