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

export const HostPriceBreakdown: React.FC<HostPriceBreakdownProps> = ({
  estimate,
  displayMode = "hourly",
  title = "Estimated cost breakdown",
}) => {
  const emphasizeHourly = displayMode !== "monthly";
  const amountTextStyle = (emphasized: boolean) => ({
    fontVariantNumeric: "tabular-nums" as const,
    fontWeight: emphasized ? 600 : 400,
    opacity: emphasized ? 1 : 0.85,
  });

  return (
    <div
      style={{
        border: "1px solid #f0f0f0",
        borderRadius: 8,
        padding: 12,
        width: "100%",
      }}
    >
      <Space orientation="vertical" size={8} style={{ width: "100%" }}>
        <Typography.Text strong>{title}</Typography.Text>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto auto",
            columnGap: 12,
            alignItems: "baseline",
          }}
        >
          <div />
          <Typography.Text type="secondary">Hourly</Typography.Text>
          <Typography.Text type="secondary">Monthly</Typography.Text>
        </div>
        {estimate.line_items.map((item) => (
          <div
            key={item.key}
            style={{
              alignItems: "baseline",
              columnGap: 12,
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) auto auto",
            }}
          >
            <Typography.Text type="secondary">{item.label}</Typography.Text>
            <Typography.Text style={amountTextStyle(emphasizeHourly)}>
              {item.hourly_label}
            </Typography.Text>
            <Typography.Text style={amountTextStyle(!emphasizeHourly)}>
              {item.monthly_label}
            </Typography.Text>
          </div>
        ))}
        <Divider style={{ margin: "4px 0" }} />
        <div
          style={{
            alignItems: "baseline",
            columnGap: 12,
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto auto",
          }}
        >
          <Typography.Text strong>Total</Typography.Text>
          <Typography.Text strong style={amountTextStyle(emphasizeHourly)}>
            {estimate.hourly_label}
          </Typography.Text>
          <Typography.Text strong style={amountTextStyle(!emphasizeHourly)}>
            {estimate.monthly_label}
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
