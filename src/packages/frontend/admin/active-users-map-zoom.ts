/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { select } from "d3-selection";
import {
  zoom,
  zoomIdentity,
  type D3ZoomEvent,
  type ZoomBehavior,
} from "d3-zoom";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export const ACTIVE_USERS_MAP_MIN_ZOOM = 1;
export const ACTIVE_USERS_MAP_MAX_ZOOM = 32;

export interface ActiveUsersMapViewportTransform {
  x: number;
  y: number;
  k: number;
}

interface ActiveUsersMapZoom {
  reset: () => void;
  transform: ActiveUsersMapViewportTransform;
  viewportRef: RefObject<HTMLDivElement | null>;
  zoomBy: (factor: number) => void;
}

export function useActiveUsersMapZoom(): ActiveUsersMapZoom {
  const viewportRef = useRef<HTMLDivElement>(null);
  const behaviorRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(
    null,
  );
  const [transform, setTransform] =
    useState<ActiveUsersMapViewportTransform>(zoomIdentity);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport == null) return;

    const selection = select<HTMLDivElement, unknown>(viewport);
    const behavior = zoom<HTMLDivElement, unknown>()
      .scaleExtent([ACTIVE_USERS_MAP_MIN_ZOOM, ACTIVE_USERS_MAP_MAX_ZOOM])
      .filter((event) => {
        const target = event.target;
        // Wheel gestures still work over markers, but controls and marker
        // clicks must not initiate a map drag.
        if (target instanceof Element && target.closest("[data-map-control]")) {
          return false;
        }
        if (
          event.type !== "wheel" &&
          target instanceof Element &&
          target.closest("button")
        ) {
          return false;
        }
        return !event.button;
      })
      .on("zoom", (event: D3ZoomEvent<HTMLDivElement, unknown>) =>
        setTransform(event.transform),
      );

    const updateExtent = () => {
      const { clientHeight: height, clientWidth: width } = viewport;
      if (height === 0 || width === 0) return;
      behavior
        .extent([
          [0, 0],
          [width, height],
        ])
        .translateExtent([
          [0, 0],
          [width, height],
        ]);
    };

    updateExtent();
    selection.call(behavior);
    behaviorRef.current = behavior;

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            // Pan offsets are viewport pixels, so reset after layout changes.
            updateExtent();
            selection.call(behavior.transform, zoomIdentity);
          });
    resizeObserver?.observe(viewport);

    return () => {
      resizeObserver?.disconnect();
      selection.on(".zoom", null);
      behaviorRef.current = null;
    };
  }, []);

  const zoomBy = (factor: number) => {
    const viewport = viewportRef.current;
    const behavior = behaviorRef.current;
    if (viewport == null || behavior == null) return;
    select<HTMLDivElement, unknown>(viewport).call(behavior.scaleBy, factor);
  };

  const reset = () => {
    const viewport = viewportRef.current;
    const behavior = behaviorRef.current;
    if (viewport == null || behavior == null) return;
    select<HTMLDivElement, unknown>(viewport).call(
      behavior.transform,
      zoomIdentity,
    );
  };

  return { reset, transform, viewportRef, zoomBy };
}
