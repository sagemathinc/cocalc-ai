import { Button } from "antd";
import { Tooltip } from "@cocalc/frontend/components";
import { formatAction } from "../format";
import { Icon } from "@cocalc/frontend/components/icon";

export default function CodeButton({ editor }) {
  return (
    <Tooltip title="Create executable code block">
      <Button
        size="small"
        onClick={() => {
          formatAction(editor, "format_code", []);
        }}
      >
        <Icon name="terminal" />
      </Button>
    </Tooltip>
  );
}
