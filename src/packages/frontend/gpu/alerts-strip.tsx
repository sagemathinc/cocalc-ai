/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
What CoCalc found about the key's RunPod account that needs its owner
(gpu.alerts): each alert's message says what it means and what to do. The
owner can end the ones only they can check (acknowledge), and release the
budget held for a pod CoCalc couldn't confirm.
*/

import { useState } from "react";
import { Alert, Button, Modal, Space, Typography } from "antd";
import { moneyToCurrency } from "@cocalc/util/money";
import type { GpuAlert, GpuAlertKind } from "@cocalc/util/gpu/types";

export const ALERTS_ANCHOR = "gpu-alerts";

const TITLES: Record<GpuAlertKind, string> = {
  unknown_pod: "A pod CoCalc didn't start is on your RunPod account",
  unmanaged_pod: "A pod is running outside CoCalc's control",
  key_rejected: "RunPod rejects your key",
  quarantined_reservation: "Budget held for a pod CoCalc couldn't confirm",
  compromise_awaiting_revocation: "Delete your compromised key at RunPod",
  compromise_check_pods: "Check your RunPod account for pods",
  spend_drift: "RunPod billed a pod well above CoCalc's estimate",
  billing_missing: "RunPod's billing never fully covered a pod",
  over_budget: "Billing pushed spending past a GPU budget",
  account_spend_rate: "Your RunPod account is spending faster than your pods",
  account_balance_drop:
    "Your RunPod balance dropped more than your pods explain",
  account_checks_disabled: "RunPod account checks are off",
};

const SEVERITY_LABELS = {
  critical: "Critical",
  warning: "Warning",
  info: "Information",
} as const;

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

// The specifics, in words: never raw JSON.
export function alertDetails(alert: GpuAlert): string[] {
  const d = alert.details ?? {};
  const out: string[] = [];
  const provider = text(d.provider_pod_id);
  if (provider) out.push(`RunPod pod ${provider}`);
  const handle = text(d.handle);
  if (handle) out.push(`CoCalc pod ${handle}`);
  const name = text(d.name);
  if (name) out.push(`named "${name}"`);
  const held = text(d.held_usd);
  if (held) out.push(`${moneyToCurrency(held)} held`);
  return out;
}

export function GpuAlertsStrip({
  alerts,
  onAcknowledge,
  onRelease,
  busy = false,
}: {
  alerts: GpuAlert[];
  // absent for viewers who can't act (course staff)
  onAcknowledge?: (alert: GpuAlert) => Promise<void>;
  // resolves true once the hold is released; false (e.g. fresh auth was
  // cancelled) keeps the confirmation open
  onRelease?: (alert: GpuAlert, pod_id: string) => Promise<boolean>;
  busy?: boolean;
}) {
  const [releasing, setReleasing] = useState<{
    alert: GpuAlert;
    pod_id: string;
  }>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  if (alerts.length === 0) return null;

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setWorking(true);
    setError("");
    try {
      return (await action()) !== false;
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      return false;
    } finally {
      setWorking(false);
    }
  }

  return (
    <section
      id={ALERTS_ANCHOR}
      aria-label="GPU alerts"
      style={{ marginTop: 12 }}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        {alerts.map((alert) => {
          const details = alertDetails(alert);
          const releasePodId =
            alert.kind === "quarantined_reservation"
              ? text(alert.details?.pod_id)
              : undefined;
          return (
            <Alert
              key={alert.id}
              role={alert.severity === "critical" ? "alert" : "status"}
              type={
                alert.severity === "critical"
                  ? "error"
                  : alert.severity === "warning"
                    ? "warning"
                    : "info"
              }
              showIcon
              title={`${SEVERITY_LABELS[alert.severity]}: ${TITLES[alert.kind] ?? alert.kind}`}
              description={
                <>
                  <div>{alert.message}</div>
                  {details.length > 0 && <div>{details.join(", ")}.</div>}
                  <Typography.Text type="secondary">
                    Since {formatTime(alert.opened)}; last seen{" "}
                    {formatTime(alert.last_seen)}.
                  </Typography.Text>
                </>
              }
              action={
                <Space orientation="vertical">
                  {alert.acknowledgeable && onAcknowledge && (
                    <Button
                      size="small"
                      disabled={busy || working}
                      aria-label={`Acknowledge: ${TITLES[alert.kind] ?? alert.kind}`}
                      onClick={() => void run(() => onAcknowledge(alert))}
                    >
                      Acknowledge
                    </Button>
                  )}
                  {releasePodId && onRelease && (
                    <Button
                      size="small"
                      disabled={busy || working}
                      aria-label={`Release the hold for ${text(alert.details?.handle) ?? "this pod"}`}
                      onClick={() =>
                        setReleasing({ alert, pod_id: releasePodId })
                      }
                    >
                      Release hold
                    </Button>
                  )}
                </Space>
              }
            />
          );
        })}
        {error && !releasing && (
          <Alert role="alert" type="error" showIcon title={error} />
        )}
      </Space>
      <Modal
        open={releasing != null}
        title="Release the held budget?"
        okText="Release hold"
        okButtonProps={{ loading: working }}
        cancelButtonProps={{ disabled: working }}
        onOk={() =>
          void (async () => {
            if (!releasing || !onRelease) return;
            const ok = await run(() =>
              onRelease(releasing.alert, releasing.pod_id),
            );
            if (ok) setReleasing(undefined);
          })()
        }
        onCancel={() => {
          if (working) return;
          setReleasing(undefined);
          setError("");
        }}
        destroyOnHidden
      >
        <p>
          Only do this after checking on RunPod&apos;s Pods page that this pod
          doesn&apos;t exist, or after terminating it there. If it is still
          running, releasing the hold lets it spend outside your GPU limits.
        </p>
        {error && <Alert role="alert" type="error" showIcon title={error} />}
      </Modal>
    </section>
  );
}
