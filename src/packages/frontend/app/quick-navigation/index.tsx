/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { IS_MACOS } from "@cocalc/frontend/feature";
import { alert_message } from "@cocalc/frontend/alerts";
import { useNavigationShortcut } from "./detector";
import { navigationPreferences } from "./preferences";
import { OPEN_NAVIGATION_EVENT } from "./events";
import { trackRecentActivity } from "./recent-activity";
import { Suspense } from "react";
import { lazyWithRetry } from "../lazy-with-retry";
import type { Destination } from "./model";

const LoadedDialog = lazyWithRetry(
  () => import("./loaded-dialog"),
  "Quick Navigation",
);

export default function QuickNavigation() {
  const settings = useTypedRedux("account", "other_settings");
  const { shortcut, delay } = navigationPreferences(settings);
  const [open, setOpen] = useState(false);
  const [handoff, setHandoff] = useState<{ target?: Destination }>();
  const origin = useRef<HTMLElement | null>(null);
  const pending = useRef<AbortController | undefined>(undefined);
  const trigger = useCallback(() => {
    pending.current?.abort();
    setHandoff(undefined);
    origin.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setOpen(true);
  }, []);
  useNavigationShortcut(shortcut, delay, trigger, !open, IS_MACOS);
  useEffect(() => {
    const openFromPreferences = () => {
      if (!open) trigger();
    };
    window.addEventListener(OPEN_NAVIGATION_EVENT, openFromPreferences);
    return () =>
      window.removeEventListener(OPEN_NAVIGATION_EVENT, openFromPreferences);
  }, [open, trigger]);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => trackRecentActivity(), []);
  function closed(target?: Destination) {
    setOpen(false);
    setHandoff({ target });
  }
  // afterClose can run before the dialog has unmounted and released its focus
  // lock. Start navigation in a passive effect, after child cleanup, so an
  // immediate focus() cannot be redirected back into the closing modal.
  useEffect(() => {
    if (open || !handoff) return;
    const { target } = handoff;
    if (!target) {
      if (origin.current?.isConnected) origin.current.focus();
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    // A later user action supersedes pending focus handoff, even when it did
    // not originate in Quick Navigation.
    const cancel = () => controller.abort();
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("keydown", cancel, true);
    window.addEventListener("blur", cancel);
    void import("./navigate")
      .then(({ navigate }) => navigate(target, controller.signal))
      .catch((err) => {
        if (!controller.signal.aborted)
          alert_message({ type: "error", message: `${err}` });
      })
      .finally(() => {
        window.removeEventListener("pointerdown", cancel, true);
        window.removeEventListener("keydown", cancel, true);
        window.removeEventListener("blur", cancel);
      });
    return () => controller.abort();
  }, [open, handoff]);
  return open ? (
    <Suspense fallback={null}>
      <LoadedDialog onClosed={closed} />
    </Suspense>
  ) : null;
}
