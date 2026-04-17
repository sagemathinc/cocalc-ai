/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DStreamOptions, DStream } from "@cocalc/conat/sync/dstream";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import jsonStableStringify from "json-stable-stringify";

type SharedDStreamOptions = Omit<
  DStreamOptions,
  "client" | "account_id" | "start_seq" | "start_checkpoint"
> & {
  account_id: string;
  maxListeners?: number;
};

type SharedDStreamEntry = {
  account_id: string;
  stream: DStream<any>;
};

const sharedStreams = new Map<string, SharedDStreamEntry>();
const sharedStreamsInFlight = new Map<string, Promise<DStream<any>>>();

let sessionListenersInitialized = false;
let signedInListener: ((mesg: { account_id?: string }) => void) | undefined;
let signedOutListener: (() => void) | undefined;
let rememberMeFailedListener: (() => void) | undefined;

function cacheKey(opts: SharedDStreamOptions): string {
  return (
    jsonStableStringify({
      account_id: opts.account_id,
      name: opts.name,
      config: opts.config,
      ephemeral: !!opts.ephemeral,
      sync: opts.sync,
      service: opts.service,
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

function closeSharedStreams(
  predicate?: (entry: { account_id: string }) => boolean,
) {
  for (const [key, entry] of Array.from(sharedStreams.entries())) {
    if (predicate != null && !predicate(entry)) {
      continue;
    }
    sharedStreams.delete(key);
    try {
      entry.stream.close?.();
    } catch {}
  }
  for (const [key, promise] of Array.from(sharedStreamsInFlight.entries())) {
    const parsed = JSON.parse(key) as { account_id?: string };
    if (
      predicate != null &&
      !predicate({ account_id: `${parsed.account_id ?? ""}` })
    ) {
      continue;
    }
    sharedStreamsInFlight.delete(key);
    void promise.then((stream) => {
      try {
        stream.close?.();
      } catch {}
    });
  }
}

function ensureSessionListeners() {
  if (sessionListenersInitialized) {
    return;
  }
  sessionListenersInitialized = true;
  signedInListener = ({ account_id }) => {
    if (!account_id) {
      closeSharedStreams();
      return;
    }
    closeSharedStreams((entry) => entry.account_id !== account_id);
  };
  signedOutListener = () => {
    closeSharedStreams();
  };
  rememberMeFailedListener = () => {
    closeSharedStreams();
  };
  webapp_client.on("signed_in", signedInListener);
  webapp_client.on("signed_out", signedOutListener);
  webapp_client.on("remember_me_failed", rememberMeFailedListener);
}

export function resetSharedAccountDStreamCacheForTests() {
  closeSharedStreams();
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

export async function getSharedAccountDStream<T>(
  opts: SharedDStreamOptions,
): Promise<DStream<T>> {
  ensureSessionListeners();
  const key = cacheKey(opts);
  const cached = sharedStreams.get(key)?.stream as DStream<T> | undefined;
  if (cached != null) {
    return applyMaxListeners(cached, opts.maxListeners);
  }
  const existing = sharedStreamsInFlight.get(key) as
    | Promise<DStream<T>>
    | undefined;
  if (existing != null) {
    return applyMaxListeners(await existing, opts.maxListeners);
  }

  const promise = webapp_client.conat_client
    .dstream<T>({
      ...opts,
      account_id: opts.account_id,
    })
    .then((stream) => {
      if (sharedStreamsInFlight.get(key) !== promise) {
        try {
          stream.close?.();
        } catch {}
        return stream;
      }
      sharedStreamsInFlight.delete(key);
      sharedStreams.set(key, {
        account_id: opts.account_id,
        stream,
      });
      stream.once?.("closed", () => {
        const cached = sharedStreams.get(key);
        if (cached?.stream === stream) {
          sharedStreams.delete(key);
        }
      });
      return stream;
    })
    .catch((err) => {
      if (sharedStreamsInFlight.get(key) === promise) {
        sharedStreamsInFlight.delete(key);
      }
      throw err;
    });

  sharedStreamsInFlight.set(key, promise as Promise<DStream<any>>);
  return applyMaxListeners(await promise, opts.maxListeners);
}
