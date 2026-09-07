/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Space, Typography } from "antd";
import type { Host, HostCatalog } from "@cocalc/conat/hub/api/hosts";
import type { DedicatedHostSurchargeSettings } from "@cocalc/util/project-host-pricing";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
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

type PriceMode = "standard" | "spot" | "stopped" | "deprovisioned";

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
    case "deprovisioned":
      return host.status === "deprovisioned"
        ? "Deprovisioned"
        : "Not provisioned";
  }
}

function modeNote(opts: {
  mode: PriceMode;
  host: Host;
  standard?: ProviderPriceEstimate;
  spot?: ProviderPriceEstimate;
}): string | undefined {
  if (opts.mode === "standard" && isSpotStandardFallbackHost(opts.host)) {
    return "standard recovery";
  }
  if (opts.mode === "spot") {
    return percentSavings(opts.standard, opts.spot);
  }
  if (opts.mode === "stopped") {
    return "disk only";
  }
  if (opts.mode === "deprovisioned") {
    return "free";
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
    <PriceSummaryRow
      label={modeLabel(mode, host)}
      note={note}
      current={current}
      estimate={estimate}
    />
  );
}

export function PriceSummaryRow({
  label,
  note,
  current,
  estimate,
}: {
  label: string;
  note?: string;
  current: boolean;
  estimate?: ProviderPriceEstimate;
}) {
  return (
    <span
      style={{
        display: "block",
        border: `1px solid ${current ? UI_COLORS.info : UI_COLORS.border}`,
        borderRadius: 8,
        boxSizing: "border-box",
        padding: "5px 7px",
        background: current ? UI_COLORS.infoBg : UI_COLORS.surface,
        boxShadow: current ? "0 1px 4px rgba(68, 116, 192, 0.18)" : undefined,
        width: "100%",
      }}
    >
      <span
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "baseline",
        }}
      >
        <Typography.Text strong={current} style={{ fontSize: 12 }}>
          {label}
        </Typography.Text>
        {note ? (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 11, whiteSpace: "nowrap" }}
          >
            {note}
          </Typography.Text>
        ) : null}
      </span>
      <span
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "baseline",
        }}
      >
        <Typography.Text
          strong={current}
          style={{ fontSize: 13, whiteSpace: "nowrap" }}
        >
          {priceLabel(estimate)}
        </Typography.Text>
        {monthlyLabel(estimate) ? (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 11, whiteSpace: "nowrap" }}
          >
            {monthlyLabel(estimate)}
          </Typography.Text>
        ) : null}
      </span>
    </span>
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
      size={compact ? 3 : 4}
      style={{ minWidth: compact ? 170 : 210, width: "100%" }}
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
      <PriceModeRow
        mode="deprovisioned"
        host={host}
        current={estimates.current_mode === "deprovisioned"}
        estimate={estimates.deprovisioned_estimate}
        standard={estimates.standard_estimate}
        spot={estimates.spot_estimate}
      />
    </Space>
  );
}
