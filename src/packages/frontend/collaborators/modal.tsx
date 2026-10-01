/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Modal } from "antd";
import type { ModalProps } from "antd";
import { useSyncExternalStore } from "react";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const media = window.matchMedia?.(reducedMotionQuery);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

function reducedMotion() {
  return window.matchMedia?.(reducedMotionQuery).matches ?? false;
}

const serverReducedMotion = () => false;

export function CollaboratorsModal({ rootClassName, ...props }: ModalProps) {
  const reduceMotion = useSyncExternalStore(
    subscribeReducedMotion,
    reducedMotion,
    serverReducedMotion,
  );
  return (
    <Modal
      {...props}
      // Disabling the motion avoids waiting for an animation-end event that a
      // zero-duration CSS override may never deliver during rapid open/close.
      transitionName={reduceMotion ? "" : props.transitionName}
      maskTransitionName={reduceMotion ? "" : props.maskTransitionName}
      rootClassName={["collaborators-modal", rootClassName]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
