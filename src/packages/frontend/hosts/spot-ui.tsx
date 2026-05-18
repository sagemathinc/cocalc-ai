import { Alert, Popover, Tag } from "antd";
import type {
  Host,
  HostCatalog,
  HostPricingModel,
  HostSpotRecoveryPhase,
} from "@cocalc/conat/hub/api/hosts";
import type { DedicatedHostSurchargeSettings } from "@cocalc/util/project-host-pricing";
import {
  getHostDisplayedPrice,
  type HostPriceCatalogSource,
} from "./providers/registry";

type HostLike =
  | Pick<
      Host,
      | "pricing_model"
      | "desired_pricing_model"
      | "effective_pricing_model"
      | "recovery_phase"
      | "spot_recovery_state"
    >
  | {
      pricing_model?: HostPricingModel | string;
      desired_pricing_model?: HostPricingModel | string;
      effective_pricing_model?: HostPricingModel | string;
      recovery_phase?: HostSpotRecoveryPhase | string;
      spot_recovery_state?: { phase?: HostSpotRecoveryPhase | string };
    };

function desiredPricingModel(host?: HostLike | null): string | undefined {
  return host?.desired_pricing_model ?? host?.pricing_model;
}

function effectivePricingModel(host?: HostLike | null): string | undefined {
  return host?.effective_pricing_model ?? host?.pricing_model;
}

export function isSpotHost(host?: HostLike | null): boolean {
  return desiredPricingModel(host) === "spot";
}

export function isSpotStandardFallbackHost(host?: HostLike | null): boolean {
  if (!isSpotHost(host)) return false;
  const phase = host?.recovery_phase ?? host?.spot_recovery_state?.phase;
  return (
    effectivePricingModel(host) === "on_demand" ||
    phase === "running_standard_fallback" ||
    phase === "probing_spot"
  );
}

function spotDescription({
  host,
  catalog,
  pricingSettings,
}: {
  host?: HostLike | null;
  catalog?: HostPriceCatalogSource | HostCatalog;
  pricingSettings?: DedicatedHostSurchargeSettings;
}) {
  const display =
    catalog && host
      ? getHostDisplayedPrice(host as Host, catalog, pricingSettings)
      : undefined;
  if (isSpotStandardFallbackHost(host)) {
    return (
      <div style={{ maxWidth: 360 }}>
        <div>
          This host is configured for spot pricing, but is currently running as
          a standard on-demand fallback while CoCalc probes for spot capacity.
        </div>
        {display?.current_estimate ? (
          <div style={{ marginTop: 8 }}>
            Current standard rate: {display.current_estimate.hourly_label} ·{" "}
            {display.current_estimate.monthly_label}
          </div>
        ) : null}
        {display?.running_estimate ? (
          <div style={{ marginTop: 4 }}>
            Spot rate when restored: {display.running_estimate.hourly_label} ·{" "}
            {display.running_estimate.monthly_label}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 320 }}>
      Spot hosts are cheaper, but the cloud provider can interrupt them at any
      time. CoCalc will try to restart them automatically, but active work can
      still be disrupted.
    </div>
  );
}

export function SpotHostTag({
  host,
  catalog,
  pricingSettings,
}: {
  host?: HostLike | null;
  catalog?: HostPriceCatalogSource | HostCatalog;
  pricingSettings?: DedicatedHostSurchargeSettings;
} = {}) {
  const fallback = isSpotStandardFallbackHost(host);
  return (
    <Popover
      trigger={["hover", "click"]}
      title={fallback ? "Spot host running as standard fallback" : "Spot host"}
      content={spotDescription({ host, catalog, pricingSettings })}
    >
      <Tag color={fallback ? "red" : "orange"} style={{ cursor: "help" }}>
        {fallback ? "standard fallback" : "spot"}
      </Tag>
    </Popover>
  );
}

export function SpotHostAlert() {
  return (
    <Alert
      type="warning"
      showIcon
      title="Spot host"
      description={spotDescription({})}
    />
  );
}
