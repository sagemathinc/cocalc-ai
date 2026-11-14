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
      | "machine"
    >
  | {
      machine?: { machine_type?: string | null } | null;
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

export interface HostMachineFallback {
  kind: "spot_alternate" | "standard_fallback";
  desired_machine_type: string;
  active_machine_type: string;
  since?: string;
}

// What a Spot host runs on instead of its configured machine: another
// machine type on Spot (the recovery phase is then idle, so nothing else
// shows it) or Standard pricing, and since when.
export function hostMachineFallback(
  host?: HostLike | null,
): HostMachineFallback | undefined {
  if (!host || !isSpotHost(host)) return undefined;
  const state = host.spot_recovery_state;
  const desired = `${host.machine?.machine_type ?? ""}`.trim();
  const active = `${state?.active_machine_type ?? ""}`.trim() || desired;
  if (isSpotStandardFallbackHost(host)) {
    return {
      kind: "standard_fallback",
      desired_machine_type: desired,
      active_machine_type: active,
      since: state?.fallback_started_at,
    };
  }
  if (!desired || active === desired) return undefined;
  return {
    kind: "spot_alternate",
    desired_machine_type: desired,
    active_machine_type: active,
    since: state?.machine_type_attempt_started_at,
  };
}

export function hostMachineFallbackLabel(
  fallback: HostMachineFallback,
): string {
  const {
    kind,
    desired_machine_type: desired,
    active_machine_type: active,
  } = fallback;
  const running =
    active && active !== desired
      ? `Running ${active} instead of ${desired}`
      : `Running ${active || desired}`;
  const how = kind === "standard_fallback" ? "on Standard pricing" : "on Spot";
  const since = fallback.since ? Date.parse(fallback.since) : NaN;
  return `${running} ${how} (spot fallback${
    Number.isFinite(since) ? ` since ${new Date(since).toLocaleString()}` : ""
  })`;
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
  if (state?.standard_hold_until) {
    const holdUntilMs = Date.parse(state.standard_hold_until);
    if (Number.isFinite(holdUntilMs)) {
      targetTimes.push(holdUntilMs);
    }
  }
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
  const machineFallback = hostMachineFallback(host);
  if (isSpotStandardFallbackHost(host)) {
    return (
      <div style={{ maxWidth: 360 }}>
        <div>
          This host is configured for spot pricing, but is currently running as
          Standard fallback while CoCalc probes for Spot capacity.
        </div>
        {machineFallback ? (
          <div style={{ marginTop: 8 }}>
            {hostMachineFallbackLabel(machineFallback)}
          </div>
        ) : null}
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
      {machineFallback ? (
        <div style={{ marginTop: 8 }}>
          {hostMachineFallbackLabel(machineFallback)}. CoCalc moves it back to
          the configured machine type later.
        </div>
      ) : null}
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
