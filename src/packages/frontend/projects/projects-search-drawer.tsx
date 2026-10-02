/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// "Search Projects" in the sidebar: find files you edited, across projects.

import { Drawer, Typography } from "antd";
import { FilenameSearch } from "./filename-search";

export function ProjectsSearchDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer title="Search projects" open={open} onClose={onClose} size={420}>
      <Typography.Paragraph type="secondary">
        Find files you edited in the last 90 days, across all your projects. Use
        % as a wildcard.
      </Typography.Paragraph>
      {open && <FilenameSearch style={{ width: "100%" }} />}
    </Drawer>
  );
}
