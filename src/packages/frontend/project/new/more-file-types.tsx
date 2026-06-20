/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Available } from "@cocalc/comm/project-configuration";
import type { MenuItems } from "@cocalc/frontend/components/dropdown-menu";
import { Icon } from "@cocalc/frontend/components";
import type { IconName } from "@cocalc/frontend/components/icon";
import { file_options } from "@cocalc/frontend/editor-tmp";
import { file_associations } from "@cocalc/frontend/file-associations";
import { BANNED_FILE_TYPES } from "@cocalc/frontend/project/redux/file-creation";
import { capitalize, keys } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { getQuickCreateSpec, isQuickCreateAvailable } from "./launcher-catalog";

interface BuildMoreFileTypeMenuItemsOptions {
  quickCreateIds: readonly string[];
  availableFeatures?: Partial<Available>;
  disabledExtensions?: readonly string[];
  onCreateFile: (ext: string) => void;
}

function normalizeDisabledExtensions(
  disabledExtensions?: readonly string[],
): Set<string> {
  return new Set<string>(
    typeof (disabledExtensions as any)?.toJS === "function"
      ? (disabledExtensions as any).toJS()
      : (disabledExtensions ?? []),
  );
}

function getFileTypeLabel(value: string) {
  const info = file_options(`x.${value}`);
  const icon = (info.icon ?? "file") as IconName;
  const name = capitalize(info.name ?? value);
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <Icon name={icon} style={{ width: 20, marginRight: 6 }} />
      {name} <span style={{ color: COLORS.GRAY }}>({value})</span>
    </span>
  );
}

export function buildMoreFileTypeMenuItems({
  quickCreateIds,
  availableFeatures,
  disabledExtensions,
  onCreateFile,
}: BuildMoreFileTypeMenuItemsOptions): MenuItems {
  const quickExts = new Set(
    quickCreateIds
      .filter((id) => isQuickCreateAvailable(id, availableFeatures))
      .map((id) => getQuickCreateSpec(id).ext),
  );
  const disabled = normalizeDisabledExtensions(disabledExtensions);
  const seen = new Set<string>();

  return keys(file_associations)
    .sort()
    .flatMap((ext) => {
      if (ext === "/" || ext === "sage") return [];
      const data = file_associations[ext];
      if (data?.exclude_from_menu) return [];
      const value = data?.ext ?? ext;
      if (
        !value ||
        value === "sage" ||
        BANNED_FILE_TYPES.has(ext) ||
        BANNED_FILE_TYPES.has(value) ||
        disabled.has(ext) ||
        disabled.has(value) ||
        quickExts.has(value)
      ) {
        return [];
      }
      const duplicateKey = data?.name ?? value;
      if (seen.has(duplicateKey)) return [];
      seen.add(duplicateKey);
      return [
        {
          key: `more:${value}`,
          label: getFileTypeLabel(value),
          onClick: () => onCreateFile(value),
        },
      ];
    });
}
