/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { Alert, Select, Typography } from "antd";
import type {
  ComputeFundingApi,
  CourseFundingSources,
  CourseFundingSourceSummary,
} from "@cocalc/conat/hub/api/compute-funding";
import type { CourseVmFundingSource } from "@cocalc/util/compute-vm-funding";
import { moneyToCurrency, toDecimal } from "@cocalc/util/money";
import { webapp_client } from "@cocalc/frontend/webapp-client";

function usableSource(source: CourseFundingSourceSummary, now: number) {
  return (
    source.available_for_new_resources === true &&
    ["active", "scheduled"].includes(source.state) &&
    Date.parse(source.starts_at) <= now &&
    Date.parse(source.ends_at) > now &&
    source.available_usd !== undefined &&
    toDecimal(source.available_usd).gt(0)
  );
}

export default function ComputeFundingSelect({
  value,
  onChange,
  onLaneChange,
  onUnavailable,
  onSourceLoaded,
  id,
  disabled,
  api = webapp_client.conat_client.hub.computeFunding,
}: {
  id?: string;
  value?: CourseVmFundingSource;
  onChange?: (source?: CourseVmFundingSource) => void;
  onLaneChange?: (lane: "account-prepaid" | "account-postpaid") => void;
  onUnavailable?: (unavailable: boolean) => void;
  onSourceLoaded?: (source?: CourseFundingSourceSummary) => void;
  disabled?: boolean;
  api?: Pick<ComputeFundingApi, "listSources">;
}) {
  const [data, setData] = useState<CourseFundingSources>();
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true;
    let fetching = false;
    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const next = await api.listSources();
        if (active) {
          setData(next);
          setError("");
        }
      } catch (err) {
        if (active) setError(String(err instanceof Error ? err.message : err));
      } finally {
        fetching = false;
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
  const selected = data?.sources.find(
    (source) =>
      source.grant_id === value?.grant_id && source.pool_id === value?.pool_id,
  );
  const asOf = Date.parse(data?.as_of ?? "");
  const stale =
    !Number.isFinite(asOf) || now - asOf > 45_000 || asOf - now > 5_000;
  const unavailable =
    !!value && (!!error || !selected || stale || !usableSource(selected, now));
  useEffect(() => onUnavailable?.(unavailable), [onUnavailable, unavailable]);
  useEffect(
    () => onSourceLoaded?.(unavailable ? undefined : selected),
    [onSourceLoaded, selected, unavailable],
  );
  return (
    <div>
      <Select
        id={id}
        aria-label="Course funding"
        style={{ width: "100%" }}
        loading={!data && !error}
        disabled={disabled}
        value={value ? `${value.pool_id}:${value.grant_id}` : "personal"}
        options={[
          { value: "personal", label: "Use my own funding" },
          ...(data?.sources ?? []).map((source) => ({
            value: `${source.pool_id}:${source.grant_id}`,
            label: `${source.label} (${source.available_usd === undefined ? "Unknown" : moneyToCurrency(source.available_usd)} available to start)`,
            disabled: !!error || stale || !usableSource(source, now),
          })),
        ]}
        onChange={(key) => {
          if (key === "personal") {
            onChange?.(undefined);
            return;
          }
          const source = data?.sources.find(
            (candidate) => `${candidate.pool_id}:${candidate.grant_id}` === key,
          );
          if (!source || error || stale || !usableSource(source, now)) return;
          onChange?.({
            kind: "course",
            pool_id: source.pool_id,
            grant_id: source.grant_id,
            payer_account_id: source.payer_account_id,
          });
          onLaneChange?.(
            source.lane === "prepaid" ? "account-prepaid" : "account-postpaid",
          );
        }}
      />
      {error && (
        <Alert
          type="warning"
          showIcon
          title="Course funding could not be loaded."
          description={error}
        />
      )}
      {unavailable && (
        <Alert
          type="error"
          showIcon
          title="The selected course funding is unavailable. It has not been changed to personal funding."
        />
      )}
      {selected && (
        <Typography.Paragraph style={{ marginTop: 8, marginBottom: 0 }}>
          Spent {moneyToCurrency(selected.spent_usd)}; reserved{" "}
          {moneyToCurrency(selected.reserved_usd)}. Credit ends{" "}
          {new Date(selected.ends_at).toLocaleString()}. No automatic charge to
          your personal account.
        </Typography.Paragraph>
      )}
    </div>
  );
}
