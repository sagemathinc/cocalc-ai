/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DKV, DKVOptions } from "@cocalc/conat/sync/dkv";
import { webapp_client } from "@cocalc/frontend/webapp-client";

type SharedDkvOptions = Omit<DKVOptions, "client" | "account_id"> & {
  account_id: string;
  maxListeners?: number;
};

type SharedDkvEntry = {
  account_id: string;
  dkv: DKV<any>;
};

const sharedDkvs = new Map<string, SharedDkvEntry>();
const sharedDkvInFlight = new Map<string, Promise<DKV<any>>>();

let sessionListenersInitialized = false;
let signedInListener: ((mesg: { account_id?: string }) => void) | undefined;
let rememberMeFailedListener: (() => void) | undefined;

function cacheKey({ account_id, name }: { account_id: string; name: string }) {
  return `${account_id}:${name}`;
}

function applyMaxListeners<T>(
  dkv: DKV<T>,
  maxListeners: number | undefined,
): DKV<T> {
  if (
    maxListeners == null ||
    typeof (dkv as any)?.setMaxListeners !== "function" ||
    typeof (dkv as any)?.getMaxListeners !== "function"
  ) {
    return dkv;
  }
  const current = (dkv as any).getMaxListeners();
  if (typeof current === "number" && current < maxListeners) {
    (dkv as any).setMaxListeners(maxListeners);
  }
  return dkv;
}

function closeSharedDkvs(predicate?: (entry: SharedDkvEntry) => boolean) {
  for (const [key, entry] of Array.from(sharedDkvs.entries())) {
    if (predicate != null && !predicate(entry)) {
      continue;
    }
    sharedDkvs.delete(key);
    try {
      entry.dkv.close?.();
    } catch {}
  }
  for (const [key, promise] of Array.from(sharedDkvInFlight.entries())) {
    const [account_id] = key.split(":");
    if (
      predicate != null &&
      !predicate({ account_id, dkv: undefined as unknown as DKV<any> })
    ) {
      continue;
    }
    sharedDkvInFlight.delete(key);
    void promise.then((dkv) => {
      try {
        dkv.close?.();
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
      closeSharedDkvs();
      return;
    }
    closeSharedDkvs((entry) => entry.account_id !== account_id);
  };
  rememberMeFailedListener = () => {
    closeSharedDkvs();
  };
  webapp_client.on?.("signed_in", signedInListener);
  webapp_client.on?.("remember_me_failed", rememberMeFailedListener);
}

export function resetSharedAccountDkvCacheForTests() {
  closeSharedDkvs();
  if (signedInListener != null) {
    webapp_client.removeListener?.("signed_in", signedInListener);
    signedInListener = undefined;
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

export async function getSharedAccountDkv<T>(
  opts: SharedDkvOptions,
): Promise<DKV<T>> {
  ensureSessionListeners();
  const key = cacheKey(opts);
  const cached = sharedDkvs.get(key)?.dkv as DKV<T> | undefined;
  if (cached != null) {
    return applyMaxListeners(cached, opts.maxListeners);
  }
  const existing = sharedDkvInFlight.get(key) as Promise<DKV<T>> | undefined;
  if (existing != null) {
    return applyMaxListeners(await existing, opts.maxListeners);
  }

  const promise = webapp_client.conat_client
    .dkv<T>({
      ...opts,
      account_id: opts.account_id,
    })
    .then((dkv) => {
      if (sharedDkvInFlight.get(key) !== promise) {
        try {
          dkv.close?.();
        } catch {}
        return dkv;
      }
      sharedDkvInFlight.delete(key);
      sharedDkvs.set(key, {
        account_id: opts.account_id,
        dkv,
      });
      dkv.once?.("closed", () => {
        const cached = sharedDkvs.get(key);
        if (cached?.dkv === dkv) {
          sharedDkvs.delete(key);
        }
      });
      return dkv;
    })
    .catch((err) => {
      if (sharedDkvInFlight.get(key) === promise) {
        sharedDkvInFlight.delete(key);
      }
      throw err;
    });

  sharedDkvInFlight.set(key, promise as Promise<DKV<any>>);
  return applyMaxListeners(await promise, opts.maxListeners);
}
