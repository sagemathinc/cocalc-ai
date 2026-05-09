import { React } from "@cocalc/frontend/app-framework";
import { Divider, Space, Typography } from "antd";
import type {
  PriceDisplayMode,
  ProviderPriceEstimate,
} from "../providers/registry";

type HostPriceBreakdownProps = {
  estimate: ProviderPriceEstimate;
  displayMode?: PriceDisplayMode;
  title?: string;
};

const amountForDisplay = (
  estimate: ProviderPriceEstimate,
  displayMode: PriceDisplayMode,
) =>
  displayMode === "monthly" ? estimate.monthly_label : estimate.hourly_label;

export const HostPriceBreakdown: React.FC<HostPriceBreakdownProps> = ({
  estimate,
  displayMode = "hourly",
  title = "Estimated cost breakdown",
}) => {
  return (
    <div
      style={{
        border: "1px solid #f0f0f0",
        borderRadius: 8,
        padding: 12,
        width: "100%",
      }}
    >
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Typography.Text strong>{title}</Typography.Text>
        {estimate.line_items.map((item) => (
          <div
            key={item.key}
            style={{
              alignItems: "baseline",
              display: "flex",
              gap: 12,
              justifyContent: "space-between",
            }}
          >
            <Typography.Text type="secondary">{item.label}</Typography.Text>
            <Typography.Text style={{ fontVariantNumeric: "tabular-nums" }}>
              {displayMode === "monthly"
                ? item.monthly_label
                : item.hourly_label}
            </Typography.Text>
          </div>
        ))}
        <Divider style={{ margin: "4px 0" }} />
        <div
          style={{
            alignItems: "baseline",
            display: "flex",
            gap: 12,
            justifyContent: "space-between",
          }}
        >
          <Typography.Text strong>Total</Typography.Text>
          <Typography.Text
            strong
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {amountForDisplay(estimate, displayMode)}
          </Typography.Text>
        </div>
        {estimate.notes.map((note) => (
          <Typography.Text key={note} type="secondary">
            {note}
          </Typography.Text>
        ))}
      </Space>
    </div>
  );
};
