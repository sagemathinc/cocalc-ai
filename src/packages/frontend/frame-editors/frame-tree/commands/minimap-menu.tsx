/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The "Minimap" submenu of the View menu, shared by the code editors and the
Jupyter notebook.

The entries are built fresh every time the menus render and read the current
preference, so the toggle says Hide or Show, the active style carries a check
mark, and the width steppers grey out at the ends of their range.  The title
bar subscribes to `useMinimapSettingsRevision()` so that a change actually
causes such a render.
*/

import type { IntlShape } from "react-intl";

import { Icon } from "@cocalc/frontend/components/icon";
import type { MinimapSettingsApi } from "@cocalc/frontend/components/minimap/settings";
import type { Command } from "./types";

// Keeps labels aligned where a sibling entry shows a check mark.
const ICON_SPACER = <span style={{ display: "inline-block", width: "1em" }} />;

export function minimapMenuChildren({
  api,
  intl,
}: {
  api: MinimapSettingsApi;
  intl: IntlShape;
}): Partial<Command>[] {
  const settings = api.read();
  // width is per style, so the step follows the active style's range
  const range = api.spec.widths[settings.kind];
  const step = Math.max(4, Math.round((range.max - range.min) / 16));
  return [
    {
      stayOpenOnClick: true,
      icon: settings.enabled ? "eye-slash" : "eye",
      label: intl.formatMessage(
        {
          id: "command.generic.minimap.toggle.label",
          defaultMessage: "{show, select, true {Hide} other {Show}} Minimap",
        },
        { show: settings.enabled },
      ),
      onClick: () => api.toggleEnabled(),
    },
    {
      stayOpenOnClick: true,
      icon: settings.kind === "text" ? "check" : ICON_SPACER,
      label: intl.formatMessage({
        id: "command.generic.minimap.text.label",
        defaultMessage: "Text",
      }),
      onClick: () => api.setKind("text"),
    },
    {
      stayOpenOnClick: true,
      icon: settings.kind === "stylized" ? "check" : ICON_SPACER,
      label: intl.formatMessage({
        id: "command.generic.minimap.stylized.label",
        defaultMessage: "Stylized",
      }),
      onClick: () => api.setKind("stylized"),
    },
    {
      stayOpenOnClick: true,
      icon: "plus",
      disabled: () => settings.width >= range.max,
      label: intl.formatMessage(
        {
          id: "command.generic.minimap.wider.label",
          defaultMessage: "Wider ({width}px)",
        },
        { width: settings.width },
      ),
      onClick: () => api.adjustWidth(step),
    },
    {
      stayOpenOnClick: true,
      icon: "minus",
      disabled: () => settings.width <= range.min,
      label: intl.formatMessage(
        {
          id: "command.generic.minimap.narrower.label",
          defaultMessage: "Narrower ({width}px)",
        },
        { width: settings.width },
      ),
      onClick: () => api.adjustWidth(-step),
    },
    {
      icon: <Icon name="gear" />,
      label: intl.formatMessage({
        id: "command.generic.minimap.settings.label",
        defaultMessage: "Minimap Settings...",
      }),
      onClick: () => api.openSettingsDialog(),
    },
  ];
}
