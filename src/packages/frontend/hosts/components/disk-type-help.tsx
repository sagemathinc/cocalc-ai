import { QuestionCircleOutlined } from "@ant-design/icons";
import { React } from "@cocalc/frontend/app-framework";
import { Button, Popover, Space, Typography } from "antd";
import type { HostProvider } from "../types";

type DiskTypeHelpProps = {
  provider?: HostProvider;
};

function diskHelpContent(provider?: HostProvider): React.ReactNode {
  if (provider === "nebius") {
    return (
      <Space direction="vertical" size={8} style={{ maxWidth: 360 }}>
        <Typography.Text>
          Nebius persistent disks are network-attached, so they are durable and
          survive VM restarts, but they are slower than local ephemeral storage.
        </Typography.Text>
        <Typography.Text>
          <strong>Network SSD IO M3</strong>: highest-performance SSD option.
        </Typography.Text>
        <Typography.Text>
          <strong>Network SSD</strong>: lower-cost SSD-backed persistent
          storage.
        </Typography.Text>
        <Typography.Text type="secondary">
          Disk cost scales with size and is billed separately from VM cost.
        </Typography.Text>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={8} style={{ maxWidth: 360 }}>
      <Typography.Text>
        GCP Persistent Disks are durable network block devices. They are
        replicated by Google and survive VM restarts, but they are slower than
        local ephemeral disks.
      </Typography.Text>
      <Typography.Text>
        <strong>Balanced SSD</strong>: best default for most general-purpose
        hosts.
      </Typography.Text>
      <Typography.Text>
        <strong>SSD</strong>: lower latency and higher IOPS, with higher cost.
      </Typography.Text>
      <Typography.Text>
        <strong>Standard (HDD)</strong>: lowest cost, best for large sequential
        I/O, not interactive random-I/O-heavy workloads.
      </Typography.Text>
      <Typography.Text type="secondary">
        Disk cost varies by region and size and is billed separately from the VM
        itself.
      </Typography.Text>
    </Space>
  );
}

export const DiskTypeLabel: React.FC<DiskTypeHelpProps> = ({ provider }) => (
  <Space size={6}>
    <span>Disk type</span>
    <Popover content={diskHelpContent(provider)} trigger="click">
      <Button
        aria-label="Disk type help"
        icon={<QuestionCircleOutlined />}
        size="small"
        type="text"
      />
    </Popover>
  </Space>
);
