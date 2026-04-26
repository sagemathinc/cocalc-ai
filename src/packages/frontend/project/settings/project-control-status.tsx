import { Alert } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { useProjectContext } from "@cocalc/frontend/project/context";

export default function ProjectControlStatus({
  style,
  banner = false,
}: {
  style?: any;
  banner?: boolean;
}) {
  const { project_id } = useProjectContext();
  const control_status = useTypedRedux({ project_id }, "control_status");
  if (!control_status) {
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
