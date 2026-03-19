import { projectSubject } from "@cocalc/conat/names";
import type { DKV, DKVOptions } from "@cocalc/conat/sync/dkv";
import { JUPYTER_SYNCDB_EXTENSIONS } from "@cocalc/util/jupyter/names";

export const JUPYTER_LIVE_RUN_SERVICE = "jupyter-live-run";
export const JUPYTER_LIVE_RUN_STORE = "jupyter-live-run-v1";

const liveRunStoreCache = new Map<
  string,
  Promise<DKV<JupyterLiveRunSnapshot>>
>();

type LiveRunStoreClient = {
  dkv?: <T>(opts: DKVOptions) => Promise<DKV<T>>;
  sync?: {
    dkv?: <T>(opts: DKVOptions) => Promise<DKV<T>>;
  };
};

export type JupyterLiveRunMessage = {
  id?: string;
  run_id?: string;
  lifecycle?: string;
  msg_type?: string;
  metadata?: unknown;
  content?: any;
  buffers?: unknown;
  done?: boolean;
  more_output?: boolean;
};

export type JupyterLiveRunBatch = {
  path: string;
  run_id: string;
  id: string;
  seq: number;
  mesgs: JupyterLiveRunMessage[];
  sent_at_ms: number;
};

export type JupyterLiveRunSnapshot = {
  path: string;
  run_id: string;
  batches: JupyterLiveRunBatch[];
  updated_at_ms: number;
  done?: boolean;
};

export function canonicalJupyterLiveRunPath(path: string): string {
  const suffix = `.${JUPYTER_SYNCDB_EXTENSIONS}`;
  if (!path.endsWith(suffix)) {
    return path;
  }
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const tail = slash === -1 ? path : path.slice(slash + 1);
  if (!tail.startsWith(".")) {
    return path;
  }
  return `${dir}${tail.slice(1, tail.length - suffix.length)}`;
}

export function jupyterLiveRunSubject(opts: {
  project_id: string;
  path: string;
}): string {
  return projectSubject({
    project_id: opts.project_id,
    service: JUPYTER_LIVE_RUN_SERVICE,
    path: canonicalJupyterLiveRunPath(opts.path),
  });
}

export function jupyterLiveRunKey(opts: {
  path: string;
  run_id: string;
}): string {
  return `${canonicalJupyterLiveRunPath(opts.path)}\n${opts.run_id}`;
}

export async function openJupyterLiveRunStore(opts: {
  client: LiveRunStoreClient;
  project_id: string;
}): Promise<DKV<JupyterLiveRunSnapshot>> {
  const cacheKey = opts.project_id;
  let store = liveRunStoreCache.get(cacheKey);
  if (store != null) {
    try {
      const existing = await store;
      if (!(existing as any)?.isClosed?.()) {
        return existing;
      }
    } catch {
      // recreate below
    }
    liveRunStoreCache.delete(cacheKey);
    store = undefined;
  }
  if (store == null) {
    const openFrontend = opts.client.dkv;
    const openCore = opts.client.sync?.dkv;
    if (openFrontend == null && openCore == null) {
      throw Error("client does not support dkv()");
    }
    store = (async () => {
      const opened =
        (await openFrontend?.<JupyterLiveRunSnapshot>({
          project_id: opts.project_id,
          name: JUPYTER_LIVE_RUN_STORE,
          ephemeral: true,
        })) ??
        (await openCore!<JupyterLiveRunSnapshot>({
          project_id: opts.project_id,
          name: JUPYTER_LIVE_RUN_STORE,
          ephemeral: true,
        }));
      const close = opened.close?.bind(opened);
      if (close != null) {
        opened.close = () => {
          liveRunStoreCache.delete(cacheKey);
          close();
        };
      }
      return opened;
    })();
    liveRunStoreCache.set(cacheKey, store);
  }
  return await store;
}
