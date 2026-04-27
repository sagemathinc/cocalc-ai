/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  connect as connectToConat,
  type Client,
} from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";
import {
  dstream,
  type DStream,
  type DStreamOptions,
} from "@cocalc/conat/sync/dstream";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { normalizeControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { RefcountLeaseManager } from "@cocalc/util/refcount/lease";
import jsonStableStringify from "json-stable-stringify";

type SharedProjectDStreamOptions = Omit<
  DStreamOptions,
  | "client"
  | "account_id"
  | "host_id"
  | "project_id"
  | "start_seq"
  | "start_checkpoint"
> & {
  project_id: string;
  maxListeners?: number;
  controlPlaneOrigin?: string;
  requireRouting?: boolean;
};

export type SharedProjectDStreamRelease = (opts?: {
  immediate?: boolean;
}) => Promise<void>;

type SharedProjectDStreamEntry = {
  stream?: DStream<any>;
  opening?: Promise<DStream<any>>;
};

const sharedStreams = new Map<string, SharedProjectDStreamEntry>();
const controlPlaneClients = new Map<string, Client>();

let leaseManager = createLeaseManager();
let sessionListenersInitialized = false;
let signedInListener: (() => void) | undefined;
let signedOutListener: (() => void) | undefined;
let rememberMeFailedListener: (() => void) | undefined;

function createLeaseManager(): RefcountLeaseManager<string> {
  return new RefcountLeaseManager<string>({
    delayMs: 0,
    disposer: closeSharedStream,
  });
}

function controlPlaneAppAddress(origin: string): string {
  return `${origin}${appBasePath === "/" ? "" : appBasePath}`;
}

function closeControlPlaneClients() {
  for (const [origin, client] of controlPlaneClients) {
    controlPlaneClients.delete(origin);
    try {
      client.close?.();
    } catch {
      // ignore close errors during cleanup
    }
  }
}

function getControlPlaneClient(origin: string): Client {
  const normalized = normalizeControlPlaneOrigin(origin);
  if (!normalized) {
    throw new Error(`invalid control plane origin: ${origin}`);
  }
  const existing = controlPlaneClients.get(normalized);
  if (existing) {
    return existing;
  }
  const client = connectToConat({
    address: controlPlaneAppAddress(normalized),
    inboxPrefix: inboxPrefix({ account_id: webapp_client.account_id }),
    auth: (cb) => cb({ browser_id: webapp_client.browser_id }),
    withCredentials: true,
    reconnection: false,
    noCache: true,
    forceNew: true,
  });
  client.on?.("closed", () => {
    if (controlPlaneClients.get(normalized) === client) {
      controlPlaneClients.delete(normalized);
    }
  });
  controlPlaneClients.set(normalized, client);
  return client;
}

function cacheKey(opts: SharedProjectDStreamOptions): string {
  return (
    jsonStableStringify({
      project_id: opts.project_id,
      name: opts.name,
      config: opts.config,
      desc: opts.desc,
      ephemeral: !!opts.ephemeral,
      noAutosave: !!opts.noAutosave,
      noCache: !!opts.noCache,
      noInventory: !!opts.noInventory,
      requireRouting: !!opts.requireRouting,
      service: opts.service,
      sync: opts.sync,
      controlPlaneOrigin: normalizeControlPlaneOrigin(opts.controlPlaneOrigin),
    }) ?? ""
  );
}

function applyMaxListeners<T>(
  stream: DStream<T>,
  maxListeners: number | undefined,
): DStream<T> {
  if (
    maxListeners == null ||
    typeof (stream as any)?.setMaxListeners !== "function" ||
    typeof (stream as any)?.getMaxListeners !== "function"
  ) {
    return stream;
  }
  const current = (stream as any).getMaxListeners();
  if (typeof current === "number" && current < maxListeners) {
    (stream as any).setMaxListeners(maxListeners);
  }
  return stream;
}

async function closeSharedStream(key: string): Promise<void> {
  const entry = sharedStreams.get(key);
  if (!entry) {
    return;
  }
  sharedStreams.delete(key);
  let stream = entry.stream;
  if (stream == null && entry.opening != null) {
    try {
      stream = await entry.opening;
    } catch {
      stream = undefined;
    }
  }
  try {
    stream?.close?.();
  } catch {
    // ignore close errors during cleanup
  }
}

function closeSharedStreams() {
  for (const key of Array.from(sharedStreams.keys())) {
    void closeSharedStream(key);
  }
  sharedStreams.clear();
  closeControlPlaneClients();
}

function ensureSessionListeners() {
  if (sessionListenersInitialized) {
    return;
  }
  sessionListenersInitialized = true;
  signedInListener = () => {
    closeSharedStreams();
    leaseManager = createLeaseManager();
  };
  signedOutListener = () => {
    closeSharedStreams();
    leaseManager = createLeaseManager();
  };
  rememberMeFailedListener = () => {
    closeSharedStreams();
    leaseManager = createLeaseManager();
  };
  webapp_client.on?.("signed_in", signedInListener);
  webapp_client.on?.("signed_out", signedOutListener);
  webapp_client.on?.("remember_me_failed", rememberMeFailedListener);
}

async function ensureSharedProjectDStream<T>(
  key: string,
  opts: SharedProjectDStreamOptions,
): Promise<DStream<T>> {
  let entry = sharedStreams.get(key);
  if (entry?.stream != null && !entry.stream.isClosed()) {
    return entry.stream as DStream<T>;
  }
  if (entry?.opening != null) {
    return (await entry.opening) as DStream<T>;
  }
  if (entry == null) {
    entry = {};
    sharedStreams.set(key, entry);
  }
  let promise: Promise<DStream<T>>;
  const normalizedControlPlaneOrigin = normalizeControlPlaneOrigin(
    opts.controlPlaneOrigin,
  );
  const {
    maxListeners: _maxListeners,
    controlPlaneOrigin: _controlPlaneOrigin,
    requireRouting,
    ...streamOpts
  } = opts;
  promise = (
    normalizedControlPlaneOrigin
      ? dstream<T>({
          ...streamOpts,
          project_id: opts.project_id,
          client: getControlPlaneClient(normalizedControlPlaneOrigin),
        })
      : webapp_client.conat_client
          .projectConat({
            project_id: opts.project_id,
            caller: "acquireSharedProjectDStream",
            requireRouting,
          })
          .then((client) =>
            dstream<T>({
              ...streamOpts,
              project_id: opts.project_id,
              client,
            }),
          )
  )
    .then((stream) => {
      if (sharedStreams.get(key) !== entry) {
        try {
          stream.close?.();
        } catch {
          // ignore close races
        }
        return stream;
      }
      entry!.stream = stream as DStream<any>;
      stream.once?.("closed", () => {
        const current = sharedStreams.get(key);
        if (current?.stream === stream) {
          delete current.stream;
          if (leaseManager.getCount(key) <= 0 && current.opening == null) {
            sharedStreams.delete(key);
          }
        }
      });
      return stream;
    })
    .finally(() => {
      const current = sharedStreams.get(key);
      if (current === entry && current?.opening === promise) {
        delete current.opening;
        if (leaseManager.getCount(key) <= 0 && current.stream == null) {
          sharedStreams.delete(key);
        }
      }
    });

  entry.opening = promise as Promise<DStream<any>>;
  return (await promise) as DStream<T>;
}

export function resetSharedProjectDStreamCacheForTests() {
  closeSharedStreams();
  leaseManager = createLeaseManager();
  if (signedInListener != null) {
    webapp_client.removeListener?.("signed_in", signedInListener);
    signedInListener = undefined;
  }
  if (signedOutListener != null) {
    webapp_client.removeListener?.("signed_out", signedOutListener);
    signedOutListener = undefined;
  }
  if (rememberMeFailedListener != null) {
    webapp_client.removeListener?.(
      "remember_me_failed",
      rememberMeFailedListener,
    );
    rememberMeFailedListener = undefined;
  }
  sessionListenersInitialized = false;
}

export async function acquireSharedProjectDStream<T>(
  opts: SharedProjectDStreamOptions,
): Promise<{ stream: DStream<T>; release: SharedProjectDStreamRelease }> {
  ensureSessionListeners();
  const key = cacheKey(opts);
  const release = await leaseManager.acquire(key);
  try {
    const stream = await ensureSharedProjectDStream<T>(key, opts);
    return {
      stream: applyMaxListeners(stream, opts.maxListeners),
      release,
    };
  } catch (err) {
    await release({ immediate: true });
    throw err;
  }
}
