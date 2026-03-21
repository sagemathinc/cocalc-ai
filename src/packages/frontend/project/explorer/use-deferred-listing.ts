/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { usePrevious } from "@cocalc/frontend/app-framework/hooks";
import { hash_string } from "@cocalc/util/misc";

const LATCH_TIMEOUT_MS = 5000;
const BATCH_FLUSH_MS = 10;

interface UseDeferredListingOpts<T, E> {
  liveListing: T | undefined;
  liveExtra?: E;
  currentPath: string;
  alwaysPassThrough: boolean;
  fingerprint?: (listing: T | undefined) => string;
}

interface UseDeferredListingResult<T, E> {
  displayListing: T | undefined;
  displayExtra: E | undefined;
  hasPending: boolean;
  flush: () => void;
  allowNextUpdate: () => void;
}

export function useDeferredListing<T, E = undefined>({
  liveListing,
  liveExtra,
  currentPath,
  alwaysPassThrough,
  fingerprint: fingerprintFn,
}: UseDeferredListingOpts<T, E>): UseDeferredListingResult<T, E> {
  const liveFP = fingerprintFn?.(liveListing) ?? null;
  const [committed, setCommitted] = useState<{
    listing: T | undefined;
    extra: E | undefined;
    fp: string | null;
  }>({ listing: liveListing, extra: liveExtra, fp: liveFP });

  const latestRef = useRef({
    listing: liveListing,
    extra: liveExtra,
    fp: liveFP,
  });
  latestRef.current = { listing: liveListing, extra: liveExtra, fp: liveFP };

  const mountFPRef = useRef(liveFP);
  const graceRef = useRef(true);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openGraceWindow = useCallback(() => {
    graceRef.current = true;
    if (graceTimerRef.current != null) clearTimeout(graceTimerRef.current);
    graceTimerRef.current = setTimeout(() => {
      graceRef.current = false;
      graceTimerRef.current = null;
    }, LATCH_TIMEOUT_MS);
  }, []);

  const latchRef = useRef(false);
  const latchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    setCommitted({
      listing: latestRef.current.listing,
      extra: latestRef.current.extra,
      fp: latestRef.current.fp,
    });
  }, []);

  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const batchedFlush = useCallback(() => {
    if (batchTimerRef.current != null) clearTimeout(batchTimerRef.current);
    batchTimerRef.current = setTimeout(() => {
      batchTimerRef.current = null;
      flush();
    }, BATCH_FLUSH_MS);
  }, [flush]);

  const closeLatch = useCallback(() => {
    latchRef.current = false;
    if (latchTimerRef.current != null) {
      clearTimeout(latchTimerRef.current);
      latchTimerRef.current = null;
    }
  }, []);

  const allowNextUpdate = useCallback(() => {
    latchRef.current = true;
    flush();
    if (latchTimerRef.current != null) {
      clearTimeout(latchTimerRef.current);
    }
    latchTimerRef.current = setTimeout(closeLatch, LATCH_TIMEOUT_MS);
  }, [closeLatch, flush]);

  useEffect(() => {
    openGraceWindow();
  }, [openGraceWindow]);

  useEffect(() => {
    return () => {
      if (latchTimerRef.current != null) clearTimeout(latchTimerRef.current);
      if (graceTimerRef.current != null) clearTimeout(graceTimerRef.current);
      if (batchTimerRef.current != null) clearTimeout(batchTimerRef.current);
    };
  }, []);

  const prevPath = usePrevious(currentPath);
  useEffect(() => {
    if (prevPath != null && prevPath !== currentPath) {
      flush();
      mountFPRef.current = latestRef.current.fp;
      openGraceWindow();
    }
  }, [currentPath, flush, openGraceWindow, prevPath]);

  const contentChanged = fingerprintFn
    ? liveFP !== committed.fp
    : liveListing !== committed.listing;

  useEffect(() => {
    if (!contentChanged) return;
    if (alwaysPassThrough) {
      batchedFlush();
    } else if (latchRef.current) {
      if (batchTimerRef.current != null) clearTimeout(batchTimerRef.current);
      batchTimerRef.current = setTimeout(() => {
        batchTimerRef.current = null;
        closeLatch();
        flush();
      }, BATCH_FLUSH_MS);
    } else if (committed.fp === mountFPRef.current || graceRef.current) {
      batchedFlush();
    }
  }, [
    alwaysPassThrough,
    batchedFlush,
    closeLatch,
    committed.fp,
    contentChanged,
    flush,
    liveFP,
    liveListing,
  ]);

  return {
    displayListing: committed.listing,
    displayExtra: committed.extra,
    hasPending: contentChanged,
    flush,
    allowNextUpdate,
  };
}

export function fileListingFingerprint(
  listing:
    | undefined
    | Array<{
        name?: string;
        mtime?: number;
        size?: number;
        is_public?: boolean;
        isopen?: boolean;
      }>,
): string {
  if (listing == null) return "null";
  let raw = `${listing.length}|`;
  for (const item of listing) {
    raw += [
      item.name ?? "",
      item.mtime ?? "",
      item.size ?? "",
      item.is_public ? 1 : 0,
      item.isopen ? 1 : 0,
    ].join(":");
    raw += "|";
  }
  return `${hash_string(raw)}`;
}

export function refreshListingAfterUserAction({
  allowNextUpdate,
  refresh,
}: {
  allowNextUpdate: () => void;
  refresh?: () => void;
}) {
  allowNextUpdate();
  refresh?.();
}
