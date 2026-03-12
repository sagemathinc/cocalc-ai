/*
 *  This file is part of CoCalc: Copyright © 2020-2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MenuProps } from "antd";
import type { IntlShape } from "react-intl";

import { Icon } from "@cocalc/frontend/components";
import {
  ACTION_BUTTONS_DIR,
  ACTION_BUTTONS_FILE,
  ACTION_BUTTONS_MULTI,
  isDisabledSnapshots,
} from "@cocalc/frontend/project/explorer/action-utils";
import {
  FILE_ACTIONS,
  type FileAction,
} from "@cocalc/frontend/project_actions";
import { HOME_ROOT } from "@cocalc/util/consts/files";
import { path_split } from "@cocalc/util/misc";

interface BuildFileActionItemsOptions {
  isdir: boolean;
  intl: IntlShape;
  multiple?: boolean;
  disableActions?: boolean;
  inSnapshots?: boolean;
  triggerFileAction: (action: FileAction) => void;
  fullPath?: string;
}

export function buildFileActionItems(
  opts: BuildFileActionItemsOptions,
): NonNullable<MenuProps["items"]> {
  const {
    isdir,
    intl,
    multiple = false,
    disableActions = false,
    inSnapshots = false,
    triggerFileAction,
    fullPath,
  } = opts;

  if (disableActions) return [];

  const items: NonNullable<MenuProps["items"]> = [];

  if (!multiple && fullPath) {
    const filename = path_split(fullPath).tail;
    const rootPrefix = HOME_ROOT + "/";
    const displayPath = fullPath.startsWith(rootPrefix)
      ? "/" + fullPath.slice(rootPrefix.length)
      : `~/${fullPath}`;

    items.push(
      {
        key: "copy-filename",
        label: intl.formatMessage({
          id: "project.file-context-menu.copy-filename",
          defaultMessage: "Copy filename",
        }),
        icon: <Icon name="copy" />,
        onClick: () => {
          navigator.clipboard.writeText(filename).catch(() => {});
        },
      },
      {
        key: "copy-path",
        label: intl.formatMessage({
          id: "project.file-context-menu.copy-path",
          defaultMessage: "Copy path",
        }),
        icon: <Icon name="copy" />,
        onClick: () => {
          navigator.clipboard.writeText(displayPath).catch(() => {});
        },
      },
      { key: "divider-copy", type: "divider" },
    );
  }

  const actionNames = multiple
    ? ACTION_BUTTONS_MULTI
    : isdir
      ? ACTION_BUTTONS_DIR
      : ACTION_BUTTONS_FILE;

  for (const key of actionNames) {
    if (key === "download" && !isdir) continue;
    if (key === "share") continue;

    const actionInfo = FILE_ACTIONS[key];
    if ("hideFlyout" in actionInfo && actionInfo.hideFlyout) continue;

    items.push({
      key,
      label: intl.formatMessage(actionInfo.name),
      icon: <Icon name={actionInfo.icon} />,
      disabled: isDisabledSnapshots(key) && inSnapshots,
      onClick: () => triggerFileAction(key as FileAction),
    });
  }

  return items;
}
