/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Space } from "antd";
import { useIntl } from "react-intl";
import {
  React,
  redux,
  useAccountOtherSetting,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import {
  LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  LAUNCHER_SETTINGS_KEY,
  getAccountLauncherPrefs,
  getEffectiveLauncher,
  getSiteLauncherDefaults,
  updateAccountLauncherPrefs,
} from "@cocalc/frontend/project/new/launcher-preferences";
import { LauncherCustomizeModal } from "@cocalc/frontend/project/new/launcher-customize-modal";
import { QuickCreateDropdown } from "@cocalc/frontend/project/new/quick-create-dropdown";
import { useAvailableFeatures } from "@cocalc/frontend/project/use-available-features";
import { ProjectActions } from "@cocalc/frontend/project_store";

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

const NEW_BUTTON_TOOLTIP_PROPS = {
  mouseEnterDelay: 0,
  mouseLeaveDelay: 0,
  placement: "bottom" as const,
};

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
  const [showCustomizeModal, setShowCustomizeModal] =
    React.useState<boolean>(false);
  const availableFeatures = useAvailableFeatures(project_id);
  const launcherSettings = useAccountOtherSetting(LAUNCHER_SETTINGS_KEY);
  const site_launcher_quick = useTypedRedux(
    "customize",
    LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  );
  const siteLauncherDefaults = getSiteLauncherDefaults(site_launcher_quick);
  const accountLauncherPrefs = getAccountLauncherPrefs(launcherSettings);
  const mergedLauncher = getEffectiveLauncher({
    accountPrefs: accountLauncherPrefs,
    siteDefaults: siteLauncherDefaults,
  });

  function getDisabledExtensions(): string[] {
    if (configuration != undefined) {
      const { disabled_ext } = configuration.get("main", {
        disabled_ext: undefined,
      });
      if (disabled_ext != undefined) {
        return disabled_ext;
      }
    }
    return [];
  }

  function file_dropdown_icon(): React.JSX.Element {
    return (
      <span style={{ whiteSpace: "nowrap" }}>
        <Icon name="plus-circle" /> {intl.formatMessage(labels.new)}
      </span>
    );
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

  function saveUserLauncherPrefs(prefs: any | null) {
    const next = updateAccountLauncherPrefs(launcherSettings, prefs);
    redux.getActions("account").set_other_settings(LAUNCHER_SETTINGS_KEY, next);
  }

  return (
    <>
      <Space.Compact>
        <Tooltip title="Create file or folder" {...NEW_BUTTON_TOOLTIP_PROPS}>
          <span style={{ display: "inline-flex" }}>
            <Button
              aria-label="Create file or folder"
              onClick={on_create_button_clicked}
              disabled={disabled}
            >
              {file_dropdown_icon()}{" "}
            </Button>
          </span>
        </Tooltip>

        <Tooltip title="Choose file type" {...NEW_BUTTON_TOOLTIP_PROPS}>
          <span style={{ display: "inline-flex" }}>
            <QuickCreateDropdown
              title=""
              button
              showDown
              quickCreateIds={mergedLauncher.quickCreate}
              availableFeatures={availableFeatures}
              disabledExtensions={getDisabledExtensions()}
              onCreateFile={choose_extension}
              onCreateFolder={on_create_folder_button_clicked}
              onCustomize={() => setShowCustomizeModal(true)}
            />
          </span>
        </Tooltip>
      </Space.Compact>
      <LauncherCustomizeModal
        open={showCustomizeModal}
        onClose={() => setShowCustomizeModal(false)}
        initialQuickCreate={mergedLauncher.quickCreate}
        onSave={saveUserLauncherPrefs}
      />
    </>
  );
};
