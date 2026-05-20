import { Popover } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";

const HELP_CONTENT = (
  <div style={{ maxWidth: 360 }}>
    <div>
      Set this to user@host[:port] (or an ssh-config name) so that CoCalc can
      setup the remote computer as a dedicated project host. It must be possible
      to ssh to that computer without having to type a password.
    </div>
    <div style={{ marginTop: 8 }}>
      This computer must run a recent Ubuntu Linux, sudo must work without a
      password, and it will be used only as a CoCalc project host. GPUs, x86_64,
      and aarch64 (ARM) are supported.
    </div>
  </div>
);

type SshTargetLabelProps = {
  label?: string;
};

export const SshTargetLabel: React.FC<SshTargetLabelProps> = ({
  label = "SSH target",
}) => (
  <span>
    {label}
    <Popover
      title="Remote host requirements"
      content={HELP_CONTENT}
      styles={{ root: { maxWidth: 420 } }}
    >
      <span
        style={{
          marginLeft: 6,
          display: "inline-flex",
          alignItems: "center",
          color: "#8c8c8c",
          cursor: "pointer",
        }}
      >
        <Icon name="info-circle" />
      </span>
    </Popover>
  </span>
);
