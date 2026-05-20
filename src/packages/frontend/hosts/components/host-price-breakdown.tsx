import { React } from "@cocalc/frontend/app-framework";
import { Button, Divider, Popover, Space, Typography } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { COLORS } from "@cocalc/util/theme";
import type {
  PriceDisplayMode,
  ProviderPriceEstimate,
} from "../providers/registry";

type HostPriceBreakdownProps = {
  estimate: ProviderPriceEstimate;
  displayMode?: PriceDisplayMode;
  title?: string;
  compact?: boolean;
};

export const HostPriceBreakdown: React.FC<HostPriceBreakdownProps> = ({
  estimate,
  displayMode = "hourly",
  title = "Estimated cost breakdown",
  compact = false,
}) => {
  const emphasizeHourly = displayMode !== "monthly";
  const amountColumnWidth = compact ? 78 : 110;
  const amountTextStyle = (emphasized: boolean) => ({
    fontVariantNumeric: "tabular-nums" as const,
    fontWeight: emphasized ? 600 : 400,
    opacity: emphasized ? 1 : 0.85,
    textAlign: "right" as const,
    justifySelf: "end" as const,
    width: amountColumnWidth,
  });
  const gridTemplateColumns = compact
    ? `minmax(0, 1fr) ${amountColumnWidth}px`
    : `minmax(0, 1fr) ${amountColumnWidth}px ${amountColumnWidth}px`;
  const displayedAmount = (
    item: ProviderPriceEstimate["line_items"][number],
  ) => (displayMode === "monthly" ? item.monthly_label : item.hourly_label);
  const totalDisplayedAmount =
    displayMode === "monthly" ? estimate.monthly_label : estimate.hourly_label;
  const notePopover = estimate.notes.length ? (
    <Popover
      trigger="click"
      content={
        <Space direction="vertical" size={6} style={{ maxWidth: 360 }}>
          {estimate.notes.map((note) => (
            <Typography.Text key={note}>{note}</Typography.Text>
          ))}
        </Space>
      }
    >
      <Button
        aria-label="Cost estimate notes"
        shape="circle"
        size="small"
        type="text"
        icon={<Icon name="info-circle" />}
      />
    </Popover>
  ) : null;

  return (
    <div
      style={{
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 8,
        padding: compact ? "8px 10px" : 12,
      }}
    >
      <Space
        orientation="vertical"
        size={compact ? 5 : 8}
        style={{ width: "100%" }}
      >
        <Space
          align="center"
          style={{ width: "100%", justifyContent: "space-between" }}
        >
          <Typography.Text strong>{title}</Typography.Text>
          {compact && notePopover}
        </Space>
        {!compact && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns,
              columnGap: 12,
              alignItems: "baseline",
            }}
          >
            <div />
            <Typography.Text type="secondary">Hourly</Typography.Text>
            <Typography.Text type="secondary">Monthly</Typography.Text>
          </div>
        )}
        {estimate.line_items.map((item) => (
          <div
            key={item.key}
            style={{
              alignItems: "baseline",
              columnGap: compact ? 8 : 12,
              display: "grid",
              gridTemplateColumns,
            }}
          >
            <Typography.Text
              type="secondary"
              ellipsis={compact ? { tooltip: item.label } : undefined}
              style={{ minWidth: 0 }}
            >
              {item.label}
            </Typography.Text>
            <Typography.Text
              style={amountTextStyle(compact ? true : emphasizeHourly)}
            >
              {compact ? displayedAmount(item) : item.hourly_label}
            </Typography.Text>
            {!compact && (
              <Typography.Text style={amountTextStyle(!emphasizeHourly)}>
                {item.monthly_label}
              </Typography.Text>
            )}
          </div>
        ))}
        <Divider style={{ margin: "4px 0" }} />
        <div
          style={{
            alignItems: "baseline",
            columnGap: compact ? 8 : 12,
            display: "grid",
            gridTemplateColumns,
          }}
        >
          <Typography.Text strong>
            Total{" "}
            {compact && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {displayMode}
              </Typography.Text>
            )}
          </Typography.Text>
          <Typography.Text
            strong
            style={amountTextStyle(compact ? true : emphasizeHourly)}
          >
            {compact ? totalDisplayedAmount : estimate.hourly_label}
          </Typography.Text>
          {!compact && (
            <Typography.Text strong style={amountTextStyle(!emphasizeHourly)}>
              {estimate.monthly_label}
            </Typography.Text>
          )}
        </div>
        {!compact &&
          estimate.notes.map((note) => (
            <Typography.Text key={note} type="secondary">
              {note}
            </Typography.Text>
          ))}
      </Space>
    </div>
  );
};
