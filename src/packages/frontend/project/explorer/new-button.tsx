/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, type MenuProps, Space } from "antd";
import { useIntl } from "react-intl";
import { React, useTypedRedux } from "@cocalc/frontend/app-framework";
import { DropdownMenu, Icon } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import {
  LAUNCHER_SITE_DEFAULTS_APPS_KEY,
  LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  LAUNCHER_SETTINGS_KEY,
  getProjectLauncherDefaults,
  getSiteLauncherDefaults,
  getUserLauncherPrefs,
  mergeLauncherSettings,
} from "@cocalc/frontend/project/new/launcher-preferences";
import { ProjectActions } from "@cocalc/frontend/project_store";
import { COLORS } from "@cocalc/util/theme";
import { EXTs as ALL_FILE_BUTTON_TYPES } from "./file-listing/utils";
import { file_options } from "@cocalc/frontend/editor-tmp";

interface Props {
  project_id: string;
  file_search: string;
  current_path: string;
  actions: ProjectActions;
  create_folder: (switch_over?: boolean) => void;
  create_file: (ext?: string, switch_over?: boolean) => void;
  configuration?;
  disabled: boolean;
}

export const NewButton: React.FC<Props> = ({
  project_id,
  file_search = "",
  actions,
  create_folder,
  create_file,
  configuration,
  disabled,
}: Props) => {
  const intl = useIntl();
  const other_settings = useTypedRedux("account", "other_settings");
  const site_launcher_quick = useTypedRedux(
    "customize",
    LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  );
  const site_launcher_apps = useTypedRedux(
    "customize",
    LAUNCHER_SITE_DEFAULTS_APPS_KEY,
  );
  const project_launcher = useTypedRedux(
    "projects",
    "project_map",
  )?.getIn([project_id, "launcher"]);
  const siteLauncherDefaults = getSiteLauncherDefaults({
    quickCreate: site_launcher_quick,
    apps: site_launcher_apps,
  });
  const mergedLauncher = mergeLauncherSettings({
    globalDefaults: siteLauncherDefaults,
    projectDefaults: getProjectLauncherDefaults(project_launcher),
    userPrefs: getUserLauncherPrefs(
      other_settings?.get?.(LAUNCHER_SETTINGS_KEY),
      project_id,
    ),
  });

  function new_file_button_types() {
    if (configuration != undefined) {
      const { disabled_ext } = configuration.get("main", {
        disabled_ext: undefined,
      });
      if (disabled_ext != undefined) {
        return ALL_FILE_BUTTON_TYPES.filter(
          (ext) => !disabled_ext.includes(ext),
        );
      }
    }
    return ALL_FILE_BUTTON_TYPES;
  }

  function file_dropdown_icon(): React.JSX.Element {
    return (
      <span style={{ whiteSpace: "nowrap" }}>
        <Icon name="plus-circle" /> {intl.formatMessage(labels.new)}
      </span>
    );
  }

  function file_dropdown_item(ext: string) {
    const data = file_options("x." + ext);
    return {
      key: ext,
      onClick: () => on_dropdown_entry_clicked(ext),
      label: (
        <span style={{ whiteSpace: "nowrap" }}>
          <Icon name={data.icon} />{" "}
          <span style={{ textTransform: "capitalize" }}>{data.name} </span>{" "}
          <span style={{ color: COLORS.GRAY_D }}>(.{ext})</span>
        </span>
      ),
    };
  }

  function choose_extension(ext: string): void {
    if (file_search.length === 0) {
      // Tell state to render an error in file search
      actions.ask_filename(ext);
    } else {
      create_file(ext);
    }
  }

  function on_create_folder_button_clicked(): void {
    if (file_search.length === 0) {
      actions.ask_filename("/");
    } else {
      create_folder();
    }
  }

  function on_dropdown_entry_clicked(key: string) {
    switch (key) {
      case "folder":
        on_create_folder_button_clicked();
        break;
      default:
        choose_extension(key);
    }
  }

  // Go to new file tab if no file is specified
  function on_create_button_clicked(): void {
    if (file_search.length === 0) {
      actions.set_active_tab("new");
    } else if (file_search[file_search.length - 1] === "/") {
      create_folder();
    } else {
      create_file();
    }
  }

  const allowedTypes = React.useMemo(
    () => new_file_button_types() as string[],
    [configuration],
  );
  const quickExtensions = React.useMemo(() => {
    const allowed = new Set<string>(allowedTypes);
    return mergedLauncher.quickCreate
      .filter((ext) => allowed.has(ext))
      .filter((ext, idx, arr) => arr.indexOf(ext) === idx);
  }, [mergedLauncher.quickCreate, allowedTypes]);
  const fullListExtensions = React.useMemo(() => {
    const quickSet = new Set<string>(quickExtensions);
    return allowedTypes.filter((ext) => !quickSet.has(ext));
  }, [allowedTypes, quickExtensions]);

  const items: MenuProps["items"] = [
    ...(React.useMemo(() => {
      const quick = quickExtensions.map((ext) => {
        const data = file_options("x." + ext);
        return {
          key: `quick:${ext}`,
          onClick: () => on_dropdown_entry_clicked(ext),
          label: (
            <span style={{ whiteSpace: "nowrap" }}>
              <Icon name={data.icon} />{" "}
              <span style={{ textTransform: "capitalize" }}>{data.name} </span>{" "}
              <span style={{ color: COLORS.GRAY_D }}>(.{ext})</span>
            </span>
          ),
        };
      });
      if (quick.length === 0) return [];
      return [
        {
          key: "__quick_create__",
          disabled: true,
          label: (
            <span style={{ color: COLORS.GRAY_D, fontWeight: 600 }}>
              Quick Create
            </span>
          ),
        },
        ...quick,
        { type: "divider" as const },
      ];
    }, [quickExtensions])),
    ...fullListExtensions.map(file_dropdown_item),
    { type: "divider" },
    {
      key: "folder",
      onClick: () => on_dropdown_entry_clicked("folder"),
      label: (
        <span style={{ whiteSpace: "nowrap" }}>
          <Icon name="folder" /> {intl.formatMessage(labels.folder)}
        </span>
      ),
    },
  ];

  return (
    <Space.Compact>
      <Button onClick={on_create_button_clicked} disabled={disabled}>
        {file_dropdown_icon()}{" "}
      </Button>

      <DropdownMenu title={""} button={true} items={items} />
    </Space.Compact>
  );
};
