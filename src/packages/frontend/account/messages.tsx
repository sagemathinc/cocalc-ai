import { Button } from "antd";

import { Panel } from "@cocalc/frontend/antd-bootstrap";
import { redux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";

export default function Messages() {
  return (
    <Panel
      size={"small"}
      style={{ marginTop: "10px" }}
      header={
        <Button
          onClick={() => {
            redux.getActions("page").set_active_tab("notifications");
            redux.getActions("mentions").set_filter("unread");
          }}
          type="link"
          style={{ fontSize: "16px", marginLeft: "-15px" }}
        >
          <Icon name="mail" /> Notification Settings
        </Button>
      }
    >
      Configure notification email in Account Preferences &rarr; Communication.
    </Panel>
  );
}
