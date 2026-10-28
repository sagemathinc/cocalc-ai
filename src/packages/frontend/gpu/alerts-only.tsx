/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The GPU alerts while no RunPod key is connected. Several exist exactly then: a
pod a forced removal left running, a pod CoCalc can't check anymore, held
budget of a removed key's pod, "check RunPod's Pods page" after a compromise.
Only acknowledge and release here: there are no pods or spend to show.
*/

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "antd";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { moneyToCurrency } from "@cocalc/util/money";
import type { GpuAlert } from "@cocalc/util/gpu/types";
import { GpuAlertsStrip } from "./alerts-strip";
import type { GpuCostDashboardApi } from "./types";

const REFRESH_MS = 60_000;

export type GpuAlertsApi = Required<
  Pick<
    GpuCostDashboardApi,
    "alerts" | "acknowledgeAlert" | "releaseQuarantined"
  >
>;

export function GpuAlertsOnly({ api }: { api: GpuAlertsApi }) {
  const apiRef = useRef(api);
  apiRef.current = api;
  const [alerts, setAlerts] = useState<GpuAlert[]>([]);
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const generation = useRef(0);

  const load = useCallback(async () => {
    const version = ++generation.current;
    try {
      const next = await apiRef.current.alerts();
      if (generation.current === version) setAlerts(next);
    } catch {
      // keep what was shown; the next poll retries
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [load]);

  async function acknowledge(alert: GpuAlert) {
    await apiRef.current.acknowledgeAlert({ id: alert.id });
    setNotice("Alert acknowledged.");
    await load();
  }

  async function release(_alert: GpuAlert, pod_id: string): Promise<boolean> {
    let result:
      | Awaited<ReturnType<GpuAlertsApi["releaseQuarantined"]>>
      | undefined;
    const completed = await runFreshAuthAction(async () => {
      result = await apiRef.current.releaseQuarantined({ pod_id });
    });
    if (!completed || !result) return false;
    setNotice(`Released ${moneyToCurrency(result.released_usd)} held.`);
    setWarning(result.warning ?? "");
    await load();
    return true;
  }

  if (alerts.length === 0 && !notice && !warning) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <div role="status" aria-live="polite">
        {notice && (
          <Alert
            type="success"
            showIcon
            title={notice}
            closable
            onClose={() => setNotice("")}
          />
        )}
      </div>
      {warning && (
        <Alert
          role="alert"
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          title="What you need to do"
          description={warning}
          closable
          onClose={() => setWarning("")}
        />
      )}
      <GpuAlertsStrip
        alerts={alerts}
        onAcknowledge={acknowledge}
        onRelease={release}
      />
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}
