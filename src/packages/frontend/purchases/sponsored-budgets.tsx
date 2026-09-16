import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Pagination, Space, Typography } from "antd";
import type {
  ComputeFundingApi,
  CourseFundingOwnedPools,
} from "@cocalc/conat/hub/api/compute-funding";
import { ComputePoolManagement } from "@cocalc/frontend/course/compute-pool-management";
import { Icon } from "@cocalc/frontend/components/icon";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { moneyToCurrency } from "@cocalc/util/money";

type Api = Pick<
  ComputeFundingApi,
  | "getOwnedPools"
  | "previewPoolChange"
  | "proposePoolChange"
  | "getAllocationStatus"
>;

export default function SponsoredBudgets({
  api = webapp_client.conat_client.hub.computeFunding,
  onApplied,
}: {
  api?: Api;
  onApplied?: () => Promise<void>;
}) {
  const [summary, setSummary] = useState<CourseFundingOwnedPools>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = await api.getOwnedPools();
      if (request !== generation.current) return;
      setSummary(result);
      setError("");
    } catch (err) {
      if (request === generation.current)
        setError(String(err instanceof Error ? err.message : err));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);

  return (
    <section aria-label="Sponsored budgets" aria-busy={loading}>
      <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
        <Typography.Title level={4}>Sponsored budgets</Typography.Title>
        <Button
          icon={<Icon name="refresh" />}
          aria-label="Refresh sponsored budgets"
          loading={loading}
          onClick={() => void refresh()}
        />
      </Space>
      {error && (
        <Alert
          type="error"
          showIcon
          title="Sponsored budgets could not be loaded."
          description={error}
        />
      )}
      {summary && (
        <>
          <Typography.Paragraph type="secondary">
            Updated {new Date(summary.as_of).toLocaleString()}
          </Typography.Paragraph>
          {summary.sponsorship?.available !== true && (
            <Alert
              type="info"
              showIcon
              title={
                summary.sponsorship?.reason ??
                "New course sponsorship is unavailable."
              }
            />
          )}
          {!summary.pools.length && (
            <Typography.Paragraph>No sponsored budgets</Typography.Paragraph>
          )}
          <ul style={{ listStyle: "none", padding: 0 }}>
            {summary.pools.slice((page - 1) * 10, page * 10).map((pool) => (
              <li key={pool.id} style={{ paddingBlock: 12 }}>
                <section aria-label={`Sponsored pool ${pool.id}`}>
                  <Typography.Title level={5}>
                    {pool.name ?? `Course budget ${pool.id.slice(0, 8)}`}
                  </Typography.Title>
                  <Typography.Paragraph>
                    {pool.state}; {pool.lane}. Allocated{" "}
                    {moneyToCurrency(pool.authorized_usd)}, spent{" "}
                    {moneyToCurrency(pool.spent_usd)}, committed{" "}
                    {moneyToCurrency(pool.reserved_usd)}, released{" "}
                    {moneyToCurrency(pool.released_usd)}.
                  </Typography.Paragraph>
                  <Typography.Paragraph type="secondary">
                    {new Date(pool.starts_at).toLocaleString()} to{" "}
                    {new Date(pool.ends_at).toLocaleString()}
                  </Typography.Paragraph>
                  <ComputePoolManagement
                    pool={pool}
                    course_project_id={pool.course_project_id}
                    course_instance_id={pool.course_instance_id}
                    students={[]}
                    api={api}
                    onUpdated={async () => {
                      await refresh();
                      await onApplied?.();
                    }}
                  />
                </section>
              </li>
            ))}
          </ul>
          {summary.pools.length > 10 && (
            <Pagination
              current={page}
              onChange={setPage}
              pageSize={10}
              total={summary.pools.length}
              showSizeChanger={false}
            />
          )}
        </>
      )}
    </section>
  );
}
