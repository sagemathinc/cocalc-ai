/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Small update indicators, in the spirit of Chrome's "Update" button: always
// visible while something is out of date (never dismissable), more urgent the
// longer the update waits. Clicking it says what is new and offers the update.
// Users can shrink it to an icon; that choice is an account setting.

import { Button, Modal, Popover, theme } from "antd";
import { useEffect, useState } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { lite } from "@cocalc/frontend/lite";
import { version } from "@cocalc/util/smc-version";
import {
  reloadForFrontendBuild,
  useFrontendBuildMonitor,
} from "./frontend-build-monitor";

export type UpdateLevel = "recommended" | "required";
export type UpdateUrgency = "low" | "elevated" | "high";

export const ICON_ONLY_SETTING = "update_indicator_icon_only";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Like Chrome: a waiting update grows more urgent after 2 and 4 days. */
export function updateUrgency(
  level: UpdateLevel,
  since: number | undefined,
  now = Date.now(),
): UpdateUrgency {
  if (level === "required") return "high";
  const days = since == null ? 0 : (now - since) / DAY_MS;
  return days >= 4 ? "high" : days >= 2 ? "elevated" : "low";
}

/** Version strings that are build times, in ms; anything else is unknown. */
export function versionTime(value: unknown): number | undefined {
  const n = Number(`${value ?? ""}`.trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

export function UpdatePill({
  level,
  since,
  label,
  description,
  actionLabel,
  onAction,
}: {
  level: UpdateLevel;
  since?: number;
  label: string;
  // What is new and what the action does, shown when the pill is clicked.
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  const { token } = theme.useToken();
  const iconOnly = !!useTypedRedux("account", "other_settings")?.get(
    ICON_ONLY_SETTING,
  );
  const [open, setOpen] = useState(false);
  const urgency = updateUrgency(level, since);
  const [color, tint] =
    urgency === "high"
      ? [token.colorError, token.colorErrorBg]
      : urgency === "elevated"
        ? [token.colorWarning, token.colorWarningBg]
        : [token.colorSuccess, token.colorSuccessBg];
  const setIconOnly = (value: boolean) => {
    setOpen(false);
    redux.getActions("account")?.set_other_settings(ICON_ONLY_SETTING, value);
  };
  const content = (
    <div style={{ maxWidth: 280 }}>
      <div>{description}</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginTop: 10,
        }}
      >
        <Button
          type="link"
          size="small"
          style={{ padding: 0, color: token.colorTextTertiary }}
          onClick={() => setIconOnly(!iconOnly)}
        >
          {iconOnly ? "Show label" : "Show as icon"}
        </Button>
        <Button
          type="primary"
          size="small"
          onClick={() => {
            setOpen(false);
            onAction();
          }}
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  );
  // Like Chrome's: a word on a tinted pill, or only the colored icon. One
  // click shows what is new, the action, and the choice of form.
  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={setOpen}
      content={content}
    >
      <Button
        size="small"
        type="text"
        aria-label={`${label}: ${description}`}
        aria-haspopup="dialog"
        icon={
          iconOnly ? (
            <Icon name="arrow-circle-up" style={{ color }} />
          ) : undefined
        }
        style={
          iconOnly
            ? { color, paddingInline: 4 }
            : {
                color,
                background: tint,
                borderRadius: 999,
                fontWeight: 500,
                paddingInline: 10,
              }
        }
      >
        {iconOnly ? undefined : label}
      </Button>
    </Popover>
  );
}

export async function hardRefresh(
  manifest?: Parameters<typeof reloadForFrontendBuild>[0],
): Promise<void> {
  try {
    if ("caches" in window) {
      const keys = await window.caches.keys();
      await Promise.all(keys.map((key) => window.caches.delete(key)));
    }
  } catch {
    // Clearing CacheStorage is best effort; a normal reload still works.
  }
  reloadForFrontendBuild(manifest);
}

/** Whether this browser tab should reload, and how urgently. */
export function useBrowserUpdate():
  | { level: UpdateLevel; since?: number; reload: () => void }
  | undefined {
  const build = useFrontendBuildMonitor();
  const minVersion = useTypedRedux("customize", "version_min_browser") ?? 0;
  const recommended =
    useTypedRedux("customize", "version_recommended_browser") ?? 0;
  const reload = () => void hardRefresh(build.current);
  if (version < minVersion) return { level: "required", reload };
  if (build.reloadRecommended || version < recommended) {
    return {
      level: "recommended",
      since: Math.min(
        build.detectedAt ?? Date.now(),
        versionTime(build.current?.build_timestamp) ?? Infinity,
      ),
      reload,
    };
  }
  return undefined;
}

// Pages can show the indicator in two places (the left panel and a top bar).
// A fallback instance appears only while no primary one is mounted.
let primaries = 0;
const primaryListeners = new Set<() => void>();
function usePrimaryMounted(primary: boolean): boolean {
  const [, render] = useState(0);
  useEffect(() => {
    const listener = () => render((n) => n + 1);
    primaryListeners.add(listener);
    if (primary) {
      primaries++;
      primaryListeners.forEach((l) => l());
    }
    return () => {
      primaryListeners.delete(listener);
      if (primary) {
        primaries--;
        primaryListeners.forEach((l) => l());
      }
    };
  }, [primary]);
  return primaries > 0;
}

const PLUS_CHECK_MS = 10 * 60 * 1000;

/*
 * CoCalc Plus installs updates in the background but never restarts itself,
 * since that would stop running notebooks and terminals. When a newer
 * release is installed than the one running, say so; it applies when Plus is
 * started again.
 */
export function usePlusRestartToUpdate():
  | { version: string; since: number }
  | undefined {
  const [pending, setPending] = useState<
    { version: string; since: number } | undefined
  >(undefined);
  useEffect(() => {
    if (!lite) return;
    let stopped = false;
    const check = async () => {
      try {
        const base = appBasePath === "/" ? "" : appBasePath;
        const response = await fetch(`${base}/plus/update-status`);
        if (!response.ok) return;
        const status = await response.json();
        if (stopped) return;
        if (status?.restartToApply && status.installed?.version) {
          setPending((current) =>
            current?.version === status.installed.version
              ? current
              : { version: status.installed.version, since: Date.now() },
          );
        } else {
          setPending(undefined);
        }
      } catch {
        // Not running as installed CoCalc Plus, or offline: no notice.
      }
    };
    void check();
    const timer = setInterval(check, PLUS_CHECK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  return pending;
}

function PlusRestartIndicator() {
  const pending = usePlusRestartToUpdate();
  if (!pending) return null;
  return (
    <UpdatePill
      level="recommended"
      since={pending.since}
      label="Restart to update"
      description={`CoCalc Plus ${pending.version} is installed. It takes effect the next time CoCalc Plus starts. Restart it when it suits you: running notebooks and terminals stop when CoCalc Plus stops.`}
      actionLabel="How to restart"
      onAction={() =>
        Modal.info({
          title: "Restart CoCalc Plus",
          content:
            "Save your work, then stop CoCalc Plus (press Control-C in the terminal running it, or run `cocalc-plus --daemon-stop` with your pidfile if it runs in the background) and start it again with `cocalc-plus`. Your previous version's data is kept as a snapshot, and `cocalc-plus update --rollback` goes back to it.",
        })
      }
    />
  );
}

export function BrowserUpdateIndicator({
  fallback = false,
}: {
  // Only when no primary indicator is on the page.
  fallback?: boolean;
}) {
  const update = useBrowserUpdate();
  const primaryMounted = usePrimaryMounted(!fallback);
  if (fallback && primaryMounted) return null;
  if (!update) return lite ? <PlusRestartIndicator /> : null;
  const required = update.level === "required";
  return (
    <UpdatePill
      level={update.level}
      since={update.since}
      label={required ? "Update required" : "Update"}
      description={
        required
          ? "This tab runs a CoCalc version that is no longer supported. Reload the page to update."
          : "A new version of CoCalc is available. Reload the page to update."
      }
      actionLabel="Reload page"
      onAction={update.reload}
    />
  );
}
