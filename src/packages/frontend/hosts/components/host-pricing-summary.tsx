/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Space, Tag, Typography } from "antd";
import type { Host, HostCatalog } from "@cocalc/conat/hub/api/hosts";
import type { DedicatedHostSurchargeSettings } from "@cocalc/util/project-host-pricing";
import { COLORS } from "@cocalc/util/theme";
import type { HostProvider } from "../types";
import {
  getHostPricingModeEstimates,
  type HostPriceCatalogSource,
  type ProviderPriceEstimate,
} from "../providers/registry";
import { isSpotStandardFallbackHost } from "../spot-ui";

type Props = {
  host: Host;
  catalog:
    | HostCatalog
    | Partial<Record<HostProvider, HostCatalog | undefined>>
    | undefined;
  pricingSettings: DedicatedHostSurchargeSettings;
  compact?: boolean;
};

type PriceMode = "standard" | "spot" | "stopped";

function percentSavings(
  standard?: ProviderPriceEstimate,
  spot?: ProviderPriceEstimate,
): string | undefined {
  if (!standard || !spot || standard.usd_per_hour <= 0) return undefined;
  const savings = Math.round(
    ((standard.usd_per_hour - spot.usd_per_hour) / standard.usd_per_hour) * 100,
  );
  if (!Number.isFinite(savings) || savings <= 0) return undefined;
  return `${savings}% less`;
}

function priceLabel(estimate?: ProviderPriceEstimate): string {
  return estimate?.hourly_label ?? "unavailable";
}

function monthlyLabel(estimate?: ProviderPriceEstimate): string | undefined {
  return estimate?.monthly_label;
}

function modeLabel(mode: PriceMode, host: Host): string {
  if (mode === "standard" && isSpotStandardFallbackHost(host)) {
    return "Standard fallback";
  }
  switch (mode) {
    case "standard":
      return "Standard";
    case "spot":
      return "Spot";
    case "stopped":
      return "Stopped";
  }
}

function modeNote(opts: {
  mode: PriceMode;
  host: Host;
  standard?: ProviderPriceEstimate;
  spot?: ProviderPriceEstimate;
}): string | undefined {
  if (opts.mode === "standard" && isSpotStandardFallbackHost(opts.host)) {
    return "on-demand recovery";
  }
  if (opts.mode === "spot") {
    return percentSavings(opts.standard, opts.spot);
  }
  if (opts.mode === "stopped") {
    return "disk only";
  }
  return undefined;
}

function PriceModeRow({
  mode,
  host,
  current,
  estimate,
  standard,
  spot,
}: {
  mode: PriceMode;
  host: Host;
  current: boolean;
  estimate?: ProviderPriceEstimate;
  standard?: ProviderPriceEstimate;
  spot?: ProviderPriceEstimate;
}) {
  const note = modeNote({ mode, host, standard, spot });
  return (
    <div
      style={{
        border: `1px solid ${current ? COLORS.BLUE_L : COLORS.GRAY_LL}`,
        borderRadius: 8,
        padding: "5px 7px",
        background: current ? COLORS.BLUE_LLLL : "white",
        boxShadow: current ? "0 1px 4px rgba(68, 116, 192, 0.18)" : undefined,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "center",
        }}
      >
        <Typography.Text strong={current} style={{ fontSize: 12 }}>
          {modeLabel(mode, host)}
        </Typography.Text>
        {current ? (
          <Tag color="blue" style={{ marginRight: 0 }}>
            Current
          </Tag>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "baseline",
        }}
      >
        <Typography.Text strong={current} style={{ fontSize: 13 }}>
          {priceLabel(estimate)}
        </Typography.Text>
        {monthlyLabel(estimate) ? (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {monthlyLabel(estimate)}
          </Typography.Text>
        ) : null}
      </div>
      {note ? (
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {note}
        </Typography.Text>
      ) : null}
    </div>
  );
}

export function HostPricingSummary({
  host,
  catalog,
  pricingSettings,
  compact = false,
}: Props) {
  const estimates = catalog
    ? getHostPricingModeEstimates(
        host,
        catalog as HostPriceCatalogSource,
        pricingSettings,
      )
    : undefined;
  if (!estimates) {
    const pricedProvider =
      host.machine?.cloud === "gcp" || host.machine?.cloud === "nebius";
    return (
      <Typography.Text type="secondary">
        {pricedProvider ? "unavailable" : "-"}
      </Typography.Text>
    );
  }
  return (
    <Space
      orientation="vertical"
      size={compact ? 4 : 6}
      style={{ minWidth: compact ? 180 : 220, width: "100%" }}
    >
      <PriceModeRow
        mode="standard"
        host={host}
        current={estimates.current_mode === "standard"}
        estimate={estimates.standard_estimate}
        standard={estimates.standard_estimate}
        spot={estimates.spot_estimate}
      />
      <PriceModeRow
        mode="spot"
        host={host}
        current={estimates.current_mode === "spot"}
        estimate={estimates.spot_estimate}
        standard={estimates.standard_estimate}
        spot={estimates.spot_estimate}
      />
      <PriceModeRow
        mode="stopped"
        host={host}
        current={estimates.current_mode === "stopped"}
        estimate={estimates.stopped_estimate}
        standard={estimates.standard_estimate}
        spot={estimates.spot_estimate}
      />
    </Space>
  );
}
