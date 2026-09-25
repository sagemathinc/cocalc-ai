/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { Alert, Typography } from "antd";
import type {
  ComputeFundingApi,
  CourseFundingSources,
} from "@cocalc/conat/hub/api/compute-funding";
import { moneyToCurrency } from "@cocalc/util/money";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export default function CourseCreditSummary({
  api = webapp_client.conat_client.hub.computeFunding,
}: {
  api?: Pick<ComputeFundingApi, "listSources">;
}) {
  const [sources, setSources] = useState<CourseFundingSources>();
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true;
    let running = false;
    async function refresh() {
      if (running) return;
      running = true;
      try {
        const result = await api.listSources({ include_inactive: true });
        if (active) {
          setSources(result);
          setError("");
        }
      } catch (err) {
        if (active) setError(String(err instanceof Error ? err.message : err));
      } finally {
        running = false;
      }
    }
    void refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api]);
  if (!sources?.sources.length && !error) return null;
  const asOf = Date.parse(sources?.as_of ?? "");
  const stale =
    !!error ||
    !Number.isFinite(asOf) ||
    now - asOf > 45_000 ||
    asOf - now > 5_000;
  return (
    <section aria-label="Your course credit" style={{ marginBottom: 16 }}>
      <Typography.Title level={5}>Your course credit</Typography.Title>
      {error && (
        <Alert
          type="warning"
          showIcon
          title="Course credit is unavailable."
          description={error}
        />
      )}
      {sources && (
        <>
          <Typography.Paragraph type="secondary">
            Updated {new Date(sources.as_of).toLocaleString()}
            {stale ? " (out of date)" : ""}
          </Typography.Paragraph>
          <div
            role="region"
            aria-label="Course credit details"
            style={{ maxWidth: "100%" }}
          >
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {sources.sources.map((source) => (
                <li
                  key={`${source.pool_id}:${source.grant_id}`}
                  style={{
                    borderTop: `1px solid ${UI_COLORS.border}`,
                    padding: "12px 0",
                    overflowWrap: "anywhere",
                  }}
                >
                  <article aria-label={`${source.label} course credit`}>
                    <Typography.Text strong>{source.label}</Typography.Text>
                    <div style={{ margin: "4px 0" }}>
                      <Typography.Text strong>
                        {!stale &&
                        source.available_for_new_resources === true &&
                        source.available_usd !== undefined
                          ? `${moneyToCurrency(source.available_usd)} available to start`
                          : "Unavailable to start"}
                      </Typography.Text>
                    </div>
                    <div>
                      {moneyToCurrency(source.spent_usd)} spent;{" "}
                      {moneyToCurrency(source.reserved_usd)} committed
                    </div>
                    <div>Ends {new Date(source.ends_at).toLocaleString()}</div>
                    {!stale &&
                      source.running_vms !== undefined &&
                      source.running_vms > 0 && (
                        <div>
                          {source.running_vms} running{" "}
                          {source.running_vms === 1 ? "VM" : "VMs"}
                          {source.hourly_usd === undefined
                            ? ""
                            : `; ${moneyToCurrency(source.hourly_usd)}/hour`}
                        </div>
                      )}
                    {!stale && source.forecast_exhausts_at && (
                      <div>
                        Estimated compute limit:{" "}
                        {new Date(source.forecast_exhausts_at).toLocaleString()}
                      </div>
                    )}
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ cursor: "pointer" }}>
                        Budget details
                      </summary>
                      <dl
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                          gap: "4px 12px",
                          margin: "8px 0",
                        }}
                      >
                        {[
                          ["Allocated", moneyToCurrency(source.authorized_usd)],
                          ["Released", moneyToCurrency(source.released_usd)],
                          ["Grant status", source.state],
                          ["Pool status", source.pool_state],
                          [
                            "Usage observed",
                            source.usage_as_of
                              ? new Date(source.usage_as_of).toLocaleString()
                              : "Unknown",
                          ],
                          [
                            "Running VMs",
                            stale
                              ? "Unknown"
                              : (source.running_vms ?? "Unknown"),
                          ],
                          [
                            "Observed hourly cost",
                            stale || source.hourly_usd === undefined
                              ? "Unknown"
                              : moneyToCurrency(source.hourly_usd),
                          ],
                          [
                            "Estimated compute limit",
                            !stale && source.forecast_exhausts_at
                              ? new Date(
                                  source.forecast_exhausts_at,
                                ).toLocaleString()
                              : "Unknown",
                          ],
                        ].map(([label, value]) => (
                          <div key={label} style={{ display: "contents" }}>
                            <dt>{label}</dt>
                            <dd style={{ margin: 0 }}>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  </article>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
