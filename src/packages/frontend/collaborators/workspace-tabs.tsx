/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useRef } from "react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { CollaboratorsView } from "./workspace-types";
export const PEOPLE_VIEWS: [CollaboratorsView, string][] = [
  ["conversations", "Conversations"],
  ["people", "Collaborators"],
  ["projects", "Shared projects"],
  ["invites", "Invites"],
  ["scan-files", "Scan Files"],
];
export function PeopleViewTabs({
  id,
  view,
  onView,
  scanSupported = false,
}: {
  id: string;
  view: CollaboratorsView;
  onView: (view: CollaboratorsView) => void;
  scanSupported?: boolean;
}) {
  const views = PEOPLE_VIEWS.filter(
    ([key]) => key !== "scan-files" || scanSupported || view === "scan-files",
  );
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div
      role="tablist"
      aria-label="People views"
      className="collaborators-tabs"
    >
      {views.map(([key, label], index) => (
        <button
          type="button"
          role="tab"
          key={key}
          id={`${id}-tab-${key}`}
          aria-controls={view === key ? `${id}-panel-${key}` : undefined}
          aria-selected={view === key}
          tabIndex={view === key ? 0 : -1}
          ref={(element) => {
            tabs.current[index] = element;
          }}
          className="collaborators-tab"
          style={{
            color: view === key ? UI_COLORS.link : UI_COLORS.secondary,
            borderBottomColor: view === key ? UI_COLORS.link : "transparent",
          }}
          onClick={() => onView(key)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % views.length
                : event.key === "ArrowLeft"
                  ? (index + views.length - 1) % views.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? views.length - 1
                      : undefined;
            if (next === undefined) return;
            event.preventDefault();
            tabs.current[next]?.focus();
            onView(views[next][0]);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
