import { useMemo } from "react";
import { useIntl } from "react-intl";
import {
  DropdownMenu,
  Icon,
  type MenuItems,
} from "@cocalc/frontend/components";
import {
  file_actions,
  type ProjectActions,
} from "@cocalc/frontend/project_store";
import type { FileAction } from "@cocalc/frontend/project_actions";
import { isDisabledSnapshots, isSnapshotPath } from "./action-utils";

interface Props {
  names: readonly FileAction[];
  current_path: string;
  actions?: ProjectActions;
  selectedPaths?: string[];
  label?: string;
  size?: "small" | "middle" | "large";
  iconOnly?: boolean;
  showDown?: boolean;
  hideFlyout?: boolean;
  activateFilesTab?: boolean;
}

export function FileActionsDropdown({
  names,
  current_path,
  actions,
  selectedPaths,
  label = "Actions",
  size,
  iconOnly,
  showDown = true,
  hideFlyout,
  activateFilesTab,
}: Props) {
  const intl = useIntl();
  const items = useMemo<MenuItems>(() => {
    if (!actions) return [];
    return names.flatMap((name) => {
      if (isSnapshotPath(current_path) && isDisabledSnapshots(name)) {
        return [];
      }
      const obj = file_actions[name];
      if (!obj) return [];
      if (hideFlyout && obj.hideFlyout) return [];
      return [
        {
          key: name,
          label: (
            <span style={{ whiteSpace: "nowrap" }}>
              <Icon name={obj.icon} style={{ marginRight: 6 }} />
              {intl.formatMessage(obj.name)}
            </span>
          ),
          onClick: () => {
            const action = name as FileAction;
            const paths = selectedPaths?.filter(Boolean) ?? [];
            if (paths.length > 0) {
              if (typeof actions.showFileActionPanelForPaths === "function") {
                void actions.showFileActionPanelForPaths({
                  paths,
                  action,
                });
                return;
              }
              if (
                paths.length === 1 &&
                typeof actions.showFileActionPanel === "function"
              ) {
                void actions.showFileActionPanel({ path: paths[0], action });
                return;
              }
            }
            if (activateFilesTab) {
              actions.set_active_tab("files");
            }
            actions.set_file_action(action);
          },
        },
      ];
    });
  }, [
    actions,
    activateFilesTab,
    current_path,
    hideFlyout,
    intl,
    names,
    selectedPaths,
  ]);

  if (!actions) return null;
  if (!items.length) return null;

  const title = iconOnly ? (
    <Icon name="ellipsis" />
  ) : (
    <span style={{ whiteSpace: "nowrap" }}>
      <Icon name="ellipsis" /> {label}
    </span>
  );

  return (
    <DropdownMenu
      button
      showDown={showDown && !iconOnly}
      size={size}
      items={items}
      title={title}
    />
  );
}
