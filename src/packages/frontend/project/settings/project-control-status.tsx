import { useEffect } from "react";
import { Alert } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { getProjectLifecycleView } from "@cocalc/frontend/projects/host-operational";

const STALE_ARCHIVE_CONTROL_STATUS = new Set([
  "Checking backups before archive...",
  "Stopping project before final backup...",
  "Creating final backup before archive...",
  "Archiving project...",
]);

export default function ProjectControlStatus({
  style,
  banner = false,
}: {
  style?: any;
  banner?: boolean;
}) {
  const { project_id } = useProjectContext();
  const control_status = useTypedRedux({ project_id }, "control_status");
  const projectMap = useTypedRedux("projects", "project_map");
  const lifecycle = getProjectLifecycleView({
    projectState: projectMap?.getIn([project_id, "state", "state"]),
    lastBackup: projectMap?.getIn([project_id, "last_backup"]),
  });
  const hideStaleArchiveStatus =
    STALE_ARCHIVE_CONTROL_STATUS.has(`${control_status ?? ""}`) &&
    lifecycle.isRawArchived;

  useEffect(() => {
    if (!hideStaleArchiveStatus) {
      return;
    }
    redux.getProjectActions(project_id)?.setState({ control_status: "" });
  }, [hideStaleArchiveStatus, project_id]);

  if (!control_status || hideStaleArchiveStatus) {
    return null;
  }

  return (
    <Alert
      banner={banner}
      type="info"
      showIcon={!banner}
      message={control_status}
      style={style}
    />
  );
}
