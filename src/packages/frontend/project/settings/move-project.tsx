import { Button, Descriptions, Modal, Spin, Tag, Typography } from "antd";
import { useActions } from "@cocalc/frontend/app-framework";
import { useEffect, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import ShowError from "@cocalc/frontend/components/error";
import { HostPickerModal } from "@cocalc/frontend/hosts/pick-host";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { DEFAULT_R2_REGION } from "@cocalc/util/consts";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import { useProjectRegion } from "../use-project-region";
import { SpotHostAlert, SpotHostTag } from "@cocalc/frontend/hosts/spot-ui";
import type { Host } from "@cocalc/conat/hub/api/hosts";

interface Props {
  project_id: string;
  disabled?: boolean;
  size?;
  force?: boolean;
  label?: string;
  showHostName?: boolean;
}

export default function MoveProject({
  project_id,
  disabled,
  size,
  force,
  label,
  showHostName = label == null,
}: Props) {
  const [moving, setMoving] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);
  const [detailsLoading, setDetailsLoading] = useState<boolean>(false);
  const [detailHost, setDetailHost] = useState<Host | undefined>();
  const actions = useActions("projects");
  const currentHostId = useTypedRedux("projects", "project_map")?.getIn([
    project_id,
    "host_id",
  ]) as string | undefined;
  const hostInfo = useHostInfo(currentHostId);
  const url = hostInfo?.get?.("connect_url");
  const hostName =
    detailHost?.name ?? hostInfo?.get?.("name") ?? url ?? "Not Assigned";
  const hostStatus = detailHost?.status ?? hostInfo?.get?.("status");
  const hostRegion = detailHost?.region ?? hostInfo?.get?.("region");
  const hostSize = detailHost?.size ?? hostInfo?.get?.("size");
  const hostTier = detailHost?.tier ?? hostInfo?.get?.("tier");
  const pricingModel =
    detailHost?.pricing_model ?? hostInfo?.get?.("pricing_model");
  const { region: projectRegionRaw, refresh: refreshProjectRegion } =
    useProjectRegion(project_id);
  const projectRegion = String(projectRegionRaw ?? DEFAULT_R2_REGION);
  const detailsItems = [
    {
      key: "name",
      label: "Host",
      children: (
        <>
          {hostName}
          {pricingModel === "spot" && (
            <span style={{ marginLeft: 8 }}>
              <SpotHostTag />
            </span>
          )}
        </>
      ),
    },
    ...(hostStatus
      ? [
          {
            key: "status",
            label: "Status",
            children: <Tag color="green">{hostStatus}</Tag>,
          },
        ]
      : []),
    ...(hostRegion
      ? [{ key: "region", label: "Region", children: hostRegion }]
      : []),
    ...(hostSize ? [{ key: "size", label: "Size", children: hostSize }] : []),
    ...(hostTier != null
      ? [
          {
            key: "tier",
            label: "Tier",
            children: `Tier ${hostTier}`,
          },
        ]
      : []),
  ];

  const openPicker = async () => {
    try {
      setMoving(true);
      refreshProjectRegion();
      setPickerOpen(true);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setMoving(false);
    }
  };

  useEffect(() => {
    if (!detailsOpen || !currentHostId) return;
    let cancelled = false;
    setDetailsLoading(true);
    void webapp_client.conat_client.hub.hosts
      .listHosts({ catalog: false })
      .then((hosts) => {
        if (cancelled) return;
        setDetailHost(hosts.find((host) => host.id === currentHostId));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(`${err}`);
      })
      .finally(() => {
        if (cancelled) return;
        setDetailsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailsOpen, currentHostId]);

  return (
    <>
      <Button
        disabled={moving || disabled || actions == null}
        size={size}
        danger={force}
        onClick={async () => {
          if (showHostName && currentHostId && hostInfo) {
            setDetailsOpen(true);
            return;
          }
          await openPicker();
        }}
      >
        <Icon name="servers" />
        {showHostName ? (
          <>
            <span
              style={{
                maxWidth: "180px",
                display: "inline-block",
                overflow: "hidden",
                textOverflow: "ellipsis",
                verticalAlign: "middle",
              }}
              title={hostName || url || "Not Assigned"}
            >
              {hostName}
            </span>
            {pricingModel === "spot" && (
              <span style={{ marginLeft: 8 }}>
                <SpotHostTag />
              </span>
            )}
          </>
        ) : (
          <span>{label ?? "Move Project"}</span>
        )}
        {moving && <Spin />}
      </Button>
      <ShowError error={error} setError={setError} />
      <Modal
        open={detailsOpen}
        title="Host details"
        destroyOnHidden
        onCancel={() => setDetailsOpen(false)}
        onOk={async () => {
          setDetailsOpen(false);
          await openPicker();
        }}
        okText="Move"
        okButtonProps={{
          disabled: moving || detailsLoading || disabled || actions == null,
        }}
      >
        <Typography.Paragraph type="secondary">
          This project is currently assigned to the following host.
        </Typography.Paragraph>
        {detailsLoading ? (
          <Spin />
        ) : (
          <Descriptions size="small" column={1} items={detailsItems} />
        )}
        {pricingModel === "spot" && (
          <div style={{ marginTop: 16 }}>
            <SpotHostAlert />
          </div>
        )}
        <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
          Click Move to choose a different destination host.
        </Typography.Paragraph>
      </Modal>
      <HostPickerModal
        open={pickerOpen}
        currentHostId={currentHostId}
        regionFilter={projectRegion}
        lockRegion
        showOfflineMoveWarning
        onCancel={() => setPickerOpen(false)}
        onSelect={async (dest_host_id) => {
          setPickerOpen(false);
          try {
            setMoving(true);
            await actions.move_project_to_host(project_id, dest_host_id);
          } catch (err) {
            setError(`${err}`);
          } finally {
            setMoving(false);
          }
        }}
      />
    </>
  );
}
