/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { Available } from "@cocalc/comm/project-configuration";
import { Icon } from "@cocalc/frontend/components";
import {
  DropdownMenu,
  type MenuItems,
} from "@cocalc/frontend/components/dropdown-menu";
import { COLORS } from "@cocalc/util/theme";
import { React } from "@cocalc/frontend/app-framework";
import { getQuickCreateSpec, isQuickCreateAvailable } from "./launcher-catalog";

interface Props {
  quickCreateIds: string[];
  availableFeatures?: Partial<Available>;
  disabledExtensions?: readonly string[];
  onCreateFile: (ext: string) => void;
  onCreateFolder: () => void;
  onCustomize: () => void;
  title?: React.JSX.Element | string;
  button?: boolean;
  showDown?: boolean;
  size?: "small" | "middle" | "large";
  style?: React.CSSProperties;
}

export function QuickCreateDropdown({
  quickCreateIds,
  availableFeatures,
  disabledExtensions,
  onCreateFile,
  onCreateFolder,
  onCustomize,
  title = (
    <span style={{ whiteSpace: "nowrap" }}>
      <Icon name="plus-circle" /> New
    </span>
  ),
  button = true,
  showDown = true,
  size,
  style,
}: Props) {
  const items = React.useMemo<MenuItems>(() => {
    const disabled = new Set<string>(
      typeof (disabledExtensions as any)?.toJS === "function"
        ? (disabledExtensions as any).toJS()
        : (disabledExtensions ?? []),
    );
    const seen = new Set<string>();
    const quick = quickCreateIds
      .filter((id) => id !== "sage")
      .filter((id) => isQuickCreateAvailable(id, availableFeatures))
      .map(getQuickCreateSpec)
      .filter((spec) => !disabled.has(spec.ext))
      .filter((spec) => {
        if (seen.has(spec.ext)) return false;
        seen.add(spec.ext);
        return true;
      });

    const menuItems: MenuItems = [];
    if (quick.length > 0) {
      menuItems.push({
        key: "__quick_create__",
        disabled: true,
        label: (
          <span style={{ color: COLORS.GRAY_D, fontWeight: 600 }}>
            Quick Create
          </span>
        ),
      });
      for (const spec of quick) {
        menuItems.push({
          key: `quick:${spec.ext}`,
          onClick: () => onCreateFile(spec.ext),
          label: (
            <span style={{ whiteSpace: "nowrap" }}>
              <Icon name={spec.icon} /> {spec.label}{" "}
              <span style={{ color: COLORS.GRAY_D }}>({spec.ext})</span>
            </span>
          ),
        });
      }
      menuItems.push({ type: "divider" });
    }

    menuItems.push(
      {
        key: "folder",
        onClick: onCreateFolder,
        label: (
          <span style={{ whiteSpace: "nowrap" }}>
            <Icon name="folder" /> Folder
          </span>
        ),
      },
      { type: "divider" },
      {
        key: "customize",
        onClick: onCustomize,
        label: (
          <span style={{ whiteSpace: "nowrap" }}>
            <Icon name="sliders" /> Customize...
          </span>
        ),
      },
    );
    return menuItems;
  }, [
    availableFeatures,
    disabledExtensions,
    onCreateFile,
    onCreateFolder,
    onCustomize,
    quickCreateIds,
  ]);

  return (
    <DropdownMenu
      title={title}
      button={button}
      showDown={showDown}
      items={items}
      size={size}
      style={style}
    />
  );
}
