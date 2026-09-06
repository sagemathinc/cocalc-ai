import { Button } from "antd";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";

export function SwitchToClassicButton({
  iconsOnly = false,
}: { iconsOnly?: boolean } = {}) {
  const { actions, id } = useFrameContext();
  return (
    <>
      <span style={{ whiteSpace: "nowrap" }}>Studio (experimental)</span>
      <Tooltip title="Return to Classic">
        <Button
          type="text"
          size="small"
          aria-label="Return to Classic"
          onClick={() => actions.set_frame_type(id, "jupyter_cell_notebook")}
        >
          <Icon name="swap" />
          {!iconsOnly && "Return to Classic"}
        </Button>
      </Tooltip>
    </>
  );
}
