import { projectSubject } from "@cocalc/conat/names";
import type { DKV, DKVOptions } from "@cocalc/conat/sync/dkv";

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

export function jupyterLiveRunSubject(opts: {
  project_id: string;
  path: string;
}): string {
  return projectSubject({
    project_id: opts.project_id,
    service: JUPYTER_LIVE_RUN_SERVICE,
    path: opts.path,
  });
}

export function jupyterLiveRunKey(opts: {
  path: string;
  run_id: string;
}): string {
  return `${opts.path}\n${opts.run_id}`;
}

export async function openJupyterLiveRunStore(opts: {
  client: LiveRunStoreClient;
  project_id: string;
}): Promise<DKV<JupyterLiveRunSnapshot>> {
  const cacheKey = opts.project_id;
  let store = liveRunStoreCache.get(cacheKey);
  if (store == null) {
    const openFrontend = opts.client.dkv;
    const openCore = opts.client.sync?.dkv;
    if (openFrontend == null && openCore == null) {
      throw Error("client does not support dkv()");
    }
    store =
      openFrontend?.<JupyterLiveRunSnapshot>({
        project_id: opts.project_id,
        name: JUPYTER_LIVE_RUN_STORE,
        ephemeral: true,
      }) ??
      openCore!<JupyterLiveRunSnapshot>({
        project_id: opts.project_id,
        name: JUPYTER_LIVE_RUN_STORE,
        ephemeral: true,
      });
    liveRunStoreCache.set(cacheKey, store);
  }
  return await store;
}
