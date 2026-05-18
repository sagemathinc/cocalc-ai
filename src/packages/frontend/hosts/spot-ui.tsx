import { Alert, Popover, Tag } from "antd";
import type {
  Host,
  HostCatalog,
  HostInterruptionRestorePolicy,
  HostPricingModel,
  HostSpotRecoveryPolicy,
  HostSpotRecoveryPhase,
  HostSpotRecoveryState,
} from "@cocalc/conat/hub/api/hosts";
import type { DedicatedHostSurchargeSettings } from "@cocalc/util/project-host-pricing";
import {
  getHostDisplayedPrice,
  type HostPriceCatalogSource,
} from "./providers/registry";
import { activeSpotRecoveryPolicy } from "./utils/spot-recovery-policy";

type HostLike =
  | Pick<
      Host,
      | "pricing_model"
      | "desired_pricing_model"
      | "effective_pricing_model"
      | "interruption_restore_policy"
      | "spot_recovery_policy"
      | "recovery_phase"
      | "spot_recovery_state"
    >
  | {
      pricing_model?: HostPricingModel | string;
      desired_pricing_model?: HostPricingModel | string;
      effective_pricing_model?: HostPricingModel | string;
      interruption_restore_policy?: HostInterruptionRestorePolicy | string;
      spot_recovery_policy?: HostSpotRecoveryPolicy;
      recovery_phase?: HostSpotRecoveryPhase | string;
      spot_recovery_state?: HostSpotRecoveryState & {
        phase?: HostSpotRecoveryPhase | string;
      };
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

function formatProbeTime(value: string | number | undefined): string {
  if (!value) return "unknown";
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return "unknown";
  return new Date(ms).toLocaleString();
}

function formatTargetProbeTime(ms: number | undefined): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const now = Date.now();
  if ((ms as number) <= now) return "waiting for cloud worker";
  const minutes = Math.max(1, Math.round(((ms as number) - now) / 60_000));
  return `${new Date(ms as number).toLocaleString()} (about ${minutes} min)`;
}

function spotRecoveryProbeDetails(host?: HostLike | null) {
  if (!host || !isSpotStandardFallbackHost(host)) return null;
  const state = host.spot_recovery_state;
  const policy = activeSpotRecoveryPolicy({
    pricingModel: desiredPricingModel(host) as HostPricingModel | undefined,
    interruptionRestorePolicy: host.interruption_restore_policy as
      | HostInterruptionRestorePolicy
      | undefined,
    spotRecoveryPolicy: host.spot_recovery_policy,
  });
  const result =
    state?.last_probe_result === "success"
      ? "available"
      : state?.last_probe_result === "failure"
        ? "unavailable"
        : "not checked yet";
  const lastProbe =
    state?.last_probe_at != null
      ? `${formatProbeTime(state.last_probe_at)} (${result})`
      : result;
  const targetTimes: number[] = [];
  if (policy) {
    if (state?.last_probe_at) {
      const lastProbeMs = Date.parse(state.last_probe_at);
      if (Number.isFinite(lastProbeMs)) {
        targetTimes.push(
          lastProbeMs + policy.spot_probe_interval_minutes * 60_000,
        );
      }
    }
    if (state?.fallback_started_at) {
      const fallbackMs = Date.parse(state.fallback_started_at);
      if (Number.isFinite(fallbackMs)) {
        targetTimes.push(
          fallbackMs + policy.standard_fallback_min_minutes * 60_000,
        );
      }
    }
  }
  const targetNext =
    targetTimes.length > 0 ? Math.max(...targetTimes) : undefined;
  const expectedNext = formatTargetProbeTime(targetNext);
  return (
    <div style={{ marginTop: 8 }}>
      <div>Last spot probe: {lastProbe}</div>
      {expectedNext ? <div>Target next probe: {expectedNext}</div> : null}
      {state?.last_probe_error ? (
        <div>Last probe error: {state.last_probe_error}</div>
      ) : null}
    </div>
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
        {spotRecoveryProbeDetails(host)}
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
