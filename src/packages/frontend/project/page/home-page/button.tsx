/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button } from "antd";

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { resolveProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";

import { path_to_file } from "@cocalc/util/misc";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export default function HomePageButton({ project_id, active, width }) {
  const actions = useActions({ project_id });
  const publicDirectorySharePath = useTypedRedux(
    { project_id },
    "public_directory_share_path",
  ) as string | undefined;

  return (
    <Button
      aria-label="Project home"
      size="large"
      type="text"
      style={{
        width,
        border: "none",
        borderRadius: "0",
        fontSize: "24px",
        color: active ? UI_COLORS.link : UI_COLORS.info,
        transitionDuration: "0s",
        background: UI_COLORS.surface,
      }}
      onClick={() => {
        void resolveProjectHomeDirectory(project_id).then((home) => {
          const sharePath = `${publicDirectorySharePath ?? ""}`
            .trim()
            .replace(/^\/+|\/+$/g, "");
          if (sharePath) {
            actions?.open_directory(
              sharePath !== "." ? path_to_file(home, sharePath) : home,
              false,
              true,
              false,
            );
            return;
          }
          actions?.open_directory(home);
        });
        actions?.setFlyoutExpanded("files", false, false);
        actions?.set_file_search("");
      }}
    >
      <Icon name="home" style={{ verticalAlign: "5px" }} />
    </Button>
  );
}
