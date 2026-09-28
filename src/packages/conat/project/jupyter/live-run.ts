import { projectSubject } from "@cocalc/conat/names";
import type { DKV, DKVOptions } from "@cocalc/conat/sync/dkv";
import { JUPYTER_SYNCDB_EXTENSIONS } from "@cocalc/util/jupyter/names";
import { sha1 } from "@cocalc/util/misc";
import { DataEncoding, encode } from "@cocalc/conat/core/codec";

export const JUPYTER_LIVE_RUN_SERVICE = "jupyter-live-run";
export const JUPYTER_LIVE_RUN_STORE_PREFIX = "jupyter-live-run-v2";

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

export type JupyterLiveRunPage = Omit<JupyterLiveRunSnapshot, "batches"> & {
  batches: JupyterLiveRunBatch[];
  next_seq: number;
  has_more: boolean;
};

export function jupyterLiveRunPage(
  snapshot: JupyterLiveRunSnapshot,
  after_seq = 0,
  limit = 32,
): JupyterLiveRunPage {
  if (
    !Number.isSafeInteger(after_seq) ||
    after_seq < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw Error("invalid run replay cursor or page size");
  }
  const page: JupyterLiveRunPage = {
    path: snapshot.path,
    run_id: snapshot.run_id,
    updated_at_ms: snapshot.updated_at_ms,
    done: snapshot.done,
    batches: [],
    next_seq: after_seq,
    has_more: false,
  };
  const maxBytes = 1024 * 1024;
  for (const batch of snapshot.batches) {
    if (batch.seq <= after_seq) continue;
    if (page.batches.length === limit) {
      page.has_more = true;
      break;
    }
    const previousSeq = page.next_seq;
    page.next_seq = batch.seq;
    page.batches.push(batch);
    if (
      encode({ encoding: DataEncoding.MsgPack, mesg: page }).length > maxBytes
    ) {
      page.batches.pop();
      page.next_seq = previousSeq;
      if (page.batches.length === 0)
        throw Error("run replay batch exceeds response limit");
      page.has_more = true;
      break;
    }
  }
  return page;
}

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

export function jupyterLiveRunStoreName(path: string): string {
  return `${JUPYTER_LIVE_RUN_STORE_PREFIX}-${sha1(canonicalJupyterLiveRunPath(path))}`;
}

export async function openJupyterLiveRunStore(opts: {
  client: LiveRunStoreClient;
  project_id: string;
  path: string;
}): Promise<DKV<JupyterLiveRunSnapshot>> {
  const openFrontend = opts.client.dkv;
  const openCore = opts.client.sync?.dkv;
  if (openFrontend == null && openCore == null) {
    throw Error("client does not support dkv()");
  }
  const canonicalPath = canonicalJupyterLiveRunPath(opts.path);
  const dkvOptions = {
    project_id: opts.project_id,
    name: jupyterLiveRunStoreName(canonicalPath),
    desc: {
      service: JUPYTER_LIVE_RUN_SERVICE,
      path: canonicalPath,
    },
    ephemeral: true,
  };
  return (
    (await openFrontend?.<JupyterLiveRunSnapshot>(dkvOptions)) ??
    (await openCore!<JupyterLiveRunSnapshot>(dkvOptions))
  );
}
