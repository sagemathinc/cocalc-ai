import { Button, Tooltip } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";

export default function SshButton() {
  return (
    <Tooltip title="SSH Sessions">
      <Button
        style={{ margin: "2.5px 0 0 6px" }}
        type="text"
        onClick={() => {
          redux.getActions("page").set_active_tab("ssh");
        }}
      >
        <Icon name="server" />
      </Button>
    </Tooltip>
  );
}
