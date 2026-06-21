import { Button } from "antd";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { redux, useRedux } from "@cocalc/frontend/app-framework";

import { IS_MOBILE } from "@cocalc/frontend/feature";

const TOUR_TOOLTIP_PROPS = {
  mouseEnterDelay: 0,
  mouseLeaveDelay: 0,
  placement: "bottom" as const,
};

export default function ProjectTourButton({ project_id }) {
  const tours = useRedux("account", "tours");
  if (IS_MOBILE || tours?.includes("all") || tours?.includes("explorer")) {
    return null;
  }
  return (
    <Tooltip title="Open tour" {...TOUR_TOOLTIP_PROPS}>
      <Button
        onClick={() => {
          redux.getProjectActions(project_id).setState({ explorerTour: true });
        }}
      >
        <Icon name="map" /> Tour
      </Button>
    </Tooltip>
  );
}
