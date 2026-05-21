// SelectNewHost is a small, reusable block used when creating a project
// (and elsewhere) to choose which host the new project should run on.
// It shows a compact summary of the current selection plus a button that
// opens the HostPickerModal. Callers provide the current host (if any) and
// get notified via onChange when the user picks or resets a host.
import { useState } from "react";
import { Button, Card, Space, Tag, Typography } from "antd";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import { Icon } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";
import { HostPickerModal } from "@cocalc/frontend/hosts/pick-host";
import {
  HostPlacementSummary,
  HostPressureTag,
} from "@cocalc/frontend/hosts/pressure-ui";
import { isSpotHost, SpotHostTag } from "@cocalc/frontend/hosts/spot-ui";

const { Paragraph } = Typography;

export function SelectNewHost({
  selectedHost,
  onChange,
  disabled,
  regionFilter,
  regionLabel,
  wantsGpu,
  pickerMode = "create",
}: {
  selectedHost?: Host;
  onChange: (host?: Host) => void;
  disabled?: boolean;
  regionFilter?: string;
  regionLabel?: string;
  wantsGpu?: boolean;
  pickerMode?: "move" | "create";
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <>
      <Space orientation="vertical" size="small" style={{ width: "100%" }}>
        <Card size="small" styles={{ body: { padding: "10px 12px" } }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontWeight: 600,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <Icon name="servers" /> Host
              </div>
              <div style={{ color: COLORS.GRAY_D }}>
                {selectedHost ? (
                  <Space orientation="vertical" size={4}>
                    <Space size={0} wrap>
                      <span style={{ marginRight: 8 }}>
                        {selectedHost.name}
                      </span>
                      {isSpotHost(selectedHost) && (
                        <SpotHostTag host={selectedHost} />
                      )}
                      {selectedHost.region && (
                        <Tag color="blue" style={{ marginRight: 6 }}>
                          {selectedHost.region}
                        </Tag>
                      )}
                      {regionLabel && (
                        <Tag color="geekblue" style={{ marginRight: 6 }}>
                          {regionLabel}
                        </Tag>
                      )}
                      <HostPressureTag pressure={selectedHost.pressure} />
                      {selectedHost.tier != null && (
                        <Tag color="purple" style={{ marginRight: 6 }}>
                          Tier {selectedHost.tier}
                        </Tag>
                      )}
                    </Space>
                    <HostPlacementSummary
                      host={selectedHost}
                      compact
                      detailMode="popover"
                      showNormal
                    />
                  </Space>
                ) : (
                  <Space orientation="vertical" size={4}>
                    <span>
                      {`Auto (best available host${regionLabel ? ` in ${regionLabel}` : ""})`}
                    </span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Auto prefers normal hosts and avoids blocked or stressed
                      placement targets when possible.
                    </Typography.Text>
                  </Space>
                )}
              </div>
            </div>
            <Button
              onClick={() => setPickerOpen(true)}
              disabled={disabled}
              size="small"
            >
              {selectedHost ? "Change..." : "Choose host..."}
            </Button>
            {selectedHost && (
              <Button
                disabled={disabled}
                onClick={() => onChange(undefined)}
                type="text"
                size="small"
              >
                Reset
              </Button>
            )}
          </div>
        </Card>
        <Paragraph
          type="secondary"
          style={{ fontSize: 12, lineHeight: 1.25, marginBottom: 0 }}
        >
          Host choice mainly affects interactive lag, such as terminal typing
          and Jupyter notebook output. You can change the host or move the
          project to another region later.
        </Paragraph>
      </Space>
      <HostPickerModal
        open={pickerOpen}
        currentHostId={pickerMode === "move" ? selectedHost?.id : undefined}
        selectedHostId={selectedHost?.id}
        regionFilter={regionFilter}
        lockRegion={pickerMode !== "create" && Boolean(regionFilter)}
        wantsGpu={wantsGpu}
        mode={pickerMode}
        onCancel={() => setPickerOpen(false)}
        onSelect={(_, host) => {
          setPickerOpen(false);
          onChange(host);
        }}
      />
    </>
  );
}
