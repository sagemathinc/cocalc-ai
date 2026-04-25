import { Alert } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { useProjectContext } from "@cocalc/frontend/project/context";

export default function ProjectControlStatus({ style }: { style?: any }) {
  const { project_id } = useProjectContext();
  const control_status = useTypedRedux({ project_id }, "control_status");
  if (!control_status) {
    return null;
  }

  return <Alert type="info" showIcon message={control_status} style={style} />;
}
