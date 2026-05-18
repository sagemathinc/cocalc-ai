import { Button } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { redux, useRedux } from "@cocalc/frontend/app-framework";

import { IS_MOBILE } from "@cocalc/frontend/feature";

export default function ProjectTourButton({ project_id }) {
  const tours = useRedux("account", "tours");
  if (IS_MOBILE || tours?.includes("all") || tours?.includes("explorer")) {
    return null;
  }
  return (
    <Button
      onClick={() => {
        redux.getProjectActions(project_id).setState({ explorerTour: true });
      }}
    >
      <Icon name="map" /> Tour
    </Button>
  );
}
