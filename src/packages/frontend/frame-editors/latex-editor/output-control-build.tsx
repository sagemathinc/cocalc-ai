/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Build Controls Component for LaTeX Editor Output Panel
Provides build, force build, clean, download, and print controls
*/

import type { SizeType } from "antd/es/config-provider/SizeContext";
import { MoonOutlined, SunOutlined } from "@ant-design/icons";

import type { MenuProps } from "antd";
import { Button, Dropdown, Space } from "antd";
import { useIntl } from "react-intl";

import { set_account_table } from "@cocalc/frontend/account/util";
import { Button as BSButton } from "@cocalc/frontend/antd-bootstrap";
import { useRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { COMMANDS } from "@cocalc/frontend/frame-editors/frame-tree/commands";
import {
  BUILD_ON_SAVE_ICON_DISABLED,
  BUILD_ON_SAVE_ICON_ENABLED,
  BUILD_ON_SAVE_LABEL,
} from "@cocalc/frontend/frame-editors/frame-tree/commands/const";
import { server_time } from "@cocalc/frontend/frame-editors/generic/client";
import { editor, IntlMessage } from "@cocalc/frontend/i18n";

import { Actions } from "./actions";

interface BuildControlsProps {
  actions: Actions;
  id?: string; // must be set if used for the PDF preview, used by the print command
  narrow?: boolean;
  size?: SizeType;
}

export function BuildControls({
  actions,
  id,
  narrow,
  size = "small",
}: BuildControlsProps) {
  const intl = useIntl();

  // Get build on save setting from account store
  const buildOnSave =
    useRedux(["account", "editor_settings", "build_on_save"]) ?? false;

  // PDF color inversion is an explicit, local choice for this view.
  const pdfInvertColorsMap = useRedux(actions.name, "pdf_invert_colors");
  const pdfInvertColors = pdfInvertColorsMap?.get?.(id) ?? false;

  const handleBuild = () => {
    actions.build();
  };

  const handleForceBuild = () => {
    actions.force_build();
  };

  const handleClean = () => {
    actions.clean();
  };

  const toggleBuildOnSave = () => {
    set_account_table({ editor_settings: { build_on_save: !buildOnSave } });
  };

  const handleReloadPdf = () => {
    actions.update_pdf(server_time().valueOf(), true);
  };

  const buildMenuItems: MenuProps["items"] = [
    {
      key: "force-build",
      label: "Force Build",
      icon: <Icon name="play-circle" />,
      onClick: handleForceBuild,
    },
    {
      key: "clean",
      label: "Clean",
      icon: <Icon name="trash" />,
      onClick: handleClean,
    },
    {
      type: "divider",
    },
    {
      key: "reload-pdf",
      label: "Reload PDF",
      icon: <Icon name="refresh" />,
      onClick: handleReloadPdf,
    },
    {
      key: "download-pdf",
      label: intl.formatMessage(COMMANDS.download_pdf.label as IntlMessage),
      icon: <Icon name="cloud-download" />,
      onClick: () => actions.download_pdf(),
    },
  ];

  if (id != null) {
    buildMenuItems.push({
      key: "print",
      label: intl.formatMessage(COMMANDS.print.label as IntlMessage),
      icon: <Icon name="print" />,
      onClick: () => actions.print(id),
    });
  }

  buildMenuItems.push({
    type: "divider",
  });

  buildMenuItems.push({
    key: "auto-build",
    icon: (
      <Icon
        name={
          buildOnSave ? BUILD_ON_SAVE_ICON_ENABLED : BUILD_ON_SAVE_ICON_DISABLED
        }
      />
    ),
    label: intl.formatMessage(BUILD_ON_SAVE_LABEL, { enabled: buildOnSave }),
    onClick: toggleBuildOnSave,
  });

  return (
    <>
      <Space.Compact size={size}>
        <Button
          type="primary"
          size={size}
          onClick={handleBuild}
          data-testid="latex-build"
        >
          <Icon name="play-circle" />
          {!narrow &&
            intl.formatMessage(editor.build_control_and_log_title_short)}
        </Button>
        <Dropdown menu={{ items: buildMenuItems }} trigger={["click"]}>
          <Button
            type="primary"
            size={size}
            icon={<Icon name="caret-down" />}
          />
        </Dropdown>
      </Space.Compact>

      {id != null && (
        <BSButton
          bsSize="xsmall"
          active={pdfInvertColors}
          aria-label={intl.formatMessage(editor.toggle_pdf_dark_mode_label)}
          aria-pressed={pdfInvertColors}
          onClick={() => actions.toggle_pdf_dark_mode(id)}
          title={intl.formatMessage(editor.toggle_pdf_dark_mode_title)}
        >
          {pdfInvertColors ? (
            <MoonOutlined aria-hidden />
          ) : (
            <SunOutlined aria-hidden />
          )}
        </BSButton>
      )}
    </>
  );
}
