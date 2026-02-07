import { Popover } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";

const HELP_CONTENT = (
  <div style={{ maxWidth: 360 }}>
    <div>
      Set this to user@host[:port] (or an ssh-config name) so that CoCalc can
      install the connector on the remote machine. It must be possible to ssh to
      that machine without having to type a password.
    </div>
    <div style={{ marginTop: 8 }}>
      This machine must run a recent Ubuntu Linux, sudo must work without a
      password, and it should be used only as a CoCalc Workspace Host. GPUs,
      x86_64, and aarch64 (ARM) are supported.
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
      overlayStyle={{ maxWidth: 420 }}
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
