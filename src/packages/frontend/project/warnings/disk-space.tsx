/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert } from "../../antd-bootstrap";
import { React, useMemo, useTypedRedux, useActions } from "../../app-framework";
import { Icon } from "../../components";
import { useProjectRunQuota } from "../use-project-run-quota";
import { ALERT_STYLE } from "./common";

export const DiskSpaceWarning: React.FC<{ project_id: string }> = ({
  project_id,
}) => {
  const projectStatus = useTypedRedux({ project_id }, "status");
  const is_commercial = useTypedRedux("customize", "is_commercial");
  const { runQuota } = useProjectRunQuota(project_id);
  // We got a report of a crash when project isn't defined; that could happen
  // when opening a project via a direct link; if the run quota isn't loaded
  // yet, we simply avoid showing the warning.
  const quotas = useMemo(
    () => (is_commercial ? (runQuota ?? undefined) : undefined),
    [is_commercial, runQuota],
  );

  const actions = useActions({ project_id });

  if (!is_commercial || quotas == null || quotas.disk_quota == null) {
    // never show a warning if project not loaded or commercial not set
    return null;
  }

  // the disk_usage comes from the project.status datatbase entry – not the "project-status" synctable
  const disk_usage = projectStatus?.get("disk_MB");
  if (disk_usage == null) return null;

  // it's fine if the usage is below the last 100MB or 90%
  if (disk_usage < Math.max(quotas.disk_quota * 0.9, quotas.disk_quota - 100)) {
    return null;
  }

  const disk_free = Math.max(0, quotas.disk_quota - disk_usage);

  return (
    <Alert bsStyle="danger" style={ALERT_STYLE}>
      <Icon name="exclamation-triangle" /> WARNING: This project is running out
      of disk space: only {disk_free} MB out of {quotas.disk_quota} MB
      available.{" "}
      <a onClick={() => actions?.set_active_tab("settings")}>
        Increase the "Disk Space" quota
      </a>
      {" or "}
      <a onClick={() => actions?.set_active_tab("files")}>delete some files</a>.
    </Alert>
  );
};
