/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Small update indicators, in the spirit of Chrome's "Update" button: always
// visible while something is out of date (never dismissable), more urgent the
// longer the update waits, and clicking it applies the update. Users can
// shrink it to an icon; that choice is an account setting.

import { Button, theme } from "antd";
import { type ReactNode, useEffect, useState } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
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
  icon = "refresh",
  onClick,
  wrap,
}: {
  level: UpdateLevel;
  since?: number;
  label: string;
  // Full sentence for screen readers and the tooltip.
  description: string;
  icon?: string;
  onClick?: () => void;
  // Wraps the action button, e.g. in a confirmation.
  wrap?: (button: ReactNode) => ReactNode;
}) {
  const { token } = theme.useToken();
  const iconOnly = !!useTypedRedux("account", "other_settings")?.get(
    ICON_ONLY_SETTING,
  );
  const urgency = updateUrgency(level, since);
  const color =
    urgency === "high"
      ? token.colorError
      : urgency === "elevated"
        ? token.colorWarning
        : token.colorSuccess;
  const setIconOnly = (value: boolean) =>
    redux.getActions("account")?.set_other_settings(ICON_ONLY_SETTING, value);
  const action = (
    <Button
      size="small"
      type="text"
      onClick={onClick}
      aria-label={description}
      title={description}
      icon={<Icon name={icon as any} style={{ color }} />}
      style={{
        color,
        fontWeight: 500,
        paddingInline: iconOnly ? 4 : 6,
        height: 22,
      }}
    >
      {iconOnly ? undefined : label}
    </Button>
  );
  return (
    <span
      role="group"
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        flex: "0 0 auto",
        border: `1px solid ${color}`,
        borderRadius: 999,
        background: token.colorBgContainer,
        lineHeight: 1,
      }}
    >
      {wrap ? wrap(action) : action}
      <Button
        size="small"
        type="text"
        aria-label={iconOnly ? "Show update label" : "Show update as an icon"}
        title={iconOnly ? "Show label" : "Shrink to an icon"}
        onClick={() => setIconOnly(!iconOnly)}
        icon={<Icon name={iconOnly ? "chevron-right" : "chevron-left"} />}
        style={{
          width: 14,
          minWidth: 14,
          height: 22,
          padding: 0,
          color: token.colorTextTertiary,
        }}
      />
    </span>
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

export function BrowserUpdateIndicator({
  fallback = false,
}: {
  // Only when no primary indicator is on the page.
  fallback?: boolean;
}) {
  const update = useBrowserUpdate();
  const primaryMounted = usePrimaryMounted(!fallback);
  if (!update || (fallback && primaryMounted)) return null;
  const required = update.level === "required";
  return (
    <UpdatePill
      level={update.level}
      since={update.since}
      label={required ? "Reload required" : "Update"}
      description={
        required
          ? "This tab runs a CoCalc version that is no longer supported. Reload it now."
          : "A new version of CoCalc is available. Reload this tab to update."
      }
      onClick={update.reload}
    />
  );
}
