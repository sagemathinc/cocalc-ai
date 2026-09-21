import { Button, Popconfirm } from "antd";
import { CaretRightOutlined, PauseOutlined } from "@ant-design/icons";
import type { ComputeVm } from "@cocalc/conat/hub/api/compute";

export default function VmPowerControls({
  vm,
  accountId,
  accountMode,
  onStart,
  onStop,
}: {
  vm: ComputeVm;
  accountId?: string;
  accountMode: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  if (!accountMode && (!accountId || vm.owner_account_id !== accountId))
    return null;
  const running = vm.desired_state === "running" && vm.state !== "stopped";
  return running ? (
    <Popconfirm
      title={`Stop ${vm.name}?`}
      description="Compute and Windows license charges stop, but persistent disk charges continue."
      okText="Stop VM"
      cancelText="Keep running"
      onConfirm={onStop}
    >
      <Button
        size="small"
        icon={<PauseOutlined aria-hidden />}
        disabled={["stopping", "deleting"].includes(vm.state)}
      >
        Stop
      </Button>
    </Popconfirm>
  ) : (
    <Button
      size="small"
      icon={<CaretRightOutlined aria-hidden />}
      disabled={["starting", "stopping", "deleting"].includes(vm.state)}
      onClick={onStart}
    >
      Start
    </Button>
  );
}
