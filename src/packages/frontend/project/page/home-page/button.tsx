/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button } from "antd";

import { useActions } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";

import { COLORS } from "@cocalc/util/theme";

export default function HomePageButton({ project_id, active, width }) {
  const actions = useActions({ project_id });

  return (
    <Button
      size="large"
      type="text"
      style={{
        width,
        border: "none",
        borderRadius: "0",
        fontSize: "24px",
        color: active ? COLORS.ANTD_LINK_BLUE : COLORS.FILE_ICON,
        transitionDuration: "0s",
        background: "#fafafa",
      }}
      onClick={() => {
        actions?.open_directory(getProjectHomeDirectory(project_id));
        actions?.setFlyoutExpanded("files", false, false);
        actions?.set_file_search("");
      }}
    >
      <Icon name="home" style={{ verticalAlign: "5px" }} />
    </Button>
  );
}
