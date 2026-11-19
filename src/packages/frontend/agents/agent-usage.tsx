/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Usage by agent: what each agent's turns used, tokens by model, as recorded
// on this site (util/ai/agent-turn-usage). Not weekly-limit percentages:
// Anthropic and OpenAI weight token kinds differently, and use on another
// site or app is not included.

import { Alert, Button, Modal, Segmented, Table, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import type {
  AgentUsageReport,
  AgentUsageRow,
} from "@cocalc/util/ai/agent-turn-usage";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { lite } from "@cocalc/frontend/lite";

const PERIODS = [
  { label: "24 hours", value: 24 },
  { label: "7 days", value: 168 },
  { label: "30 days", value: 720 },
];

/** 1234 -> "1.2k", 3_400_000 -> "3.4M". */
export function compactTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000)
    return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** How a row names its agent: the account's name, else the conversation. */
export function agentUsageLabel(row: AgentUsageRow): string {
  return row.name
    ? `@${row.name}`
    : `Conversation ${row.thread_id.slice(0, 8)}`;
}

/** Totals by provider, for the summary line. */
export function agentUsageTotals(rows: AgentUsageRow[]) {
  const totals = new Map<string, { output: number; input: number }>();
  for (const row of rows) {
    const t = totals.get(row.provider) ?? { output: 0, input: 0 };
    t.output += row.output_tokens;
    t.input +=
      row.input_tokens + row.cached_input_tokens + row.cache_write_tokens;
    totals.set(row.provider, t);
  }
  return totals;
}

export function AgentUsageModal({
  open,
  onClose,
  load = (hours: number) =>
    webapp_client.conat_client.hub.agent.agentUsage({ hours }),
}: {
  open: boolean;
  onClose: () => void;
  load?: (hours: number) => Promise<AgentUsageReport>;
}) {
  const [hours, setHours] = useState(24);
  const [report, setReport] = useState<AgentUsageReport>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError("");
    // Never show the previous period's rows under the new period.
    setReport(undefined);
    load(hours)
      .then((next) => {
        if (active) setReport(next);
      })
      .catch((err) => {
        if (active) setError(`${err}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, hours]);
  const rows = report?.rows ?? [];
  const totals = agentUsageTotals(rows);
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={900}
      title="Usage by agent"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Segmented
          aria-label="Period"
          options={PERIODS}
          value={hours}
          onChange={(value) => setHours(Number(value))}
        />
        {error && (
          <Alert
            type="warning"
            title={`Could not load usage: ${error}`}
            role="alert"
          />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Tokens by model, from the turns your agents ran on this site, busiest
          first. Tokens are not shares of a weekly limit: cache reads cost far
          less than new input or output, and use elsewhere (another site,
          claude.ai, other apps) is not included.
        </Typography.Text>
        {totals.size > 0 && (
          <div role="status">
            {[...totals].map(([provider, t]) => (
              <div key={provider}>
                {provider === "claude" ? "Claude" : "Codex"}:{" "}
                {compactTokens(t.output)} output and {compactTokens(t.input)}{" "}
                input tokens.
              </div>
            ))}
          </div>
        )}
        <Table<AgentUsageRow>
          size="small"
          loading={loading}
          pagination={rows.length > 50 ? { pageSize: 50 } : false}
          rowKey={(row) =>
            `${row.project_id}/${row.path_hash}/${row.thread_id}/${row.model}`
          }
          dataSource={rows}
          locale={{
            emptyText: loading
              ? "Loading…"
              : "No agent turns recorded in this period.",
          }}
          columns={[
            {
              title: "Agent",
              key: "agent",
              render: (_, row) => agentUsageLabel(row),
            },
            { title: "Model", dataIndex: "model", key: "model" },
            {
              title: "Turns",
              dataIndex: "turns",
              key: "turns",
              align: "right",
            },
            {
              title: "Output",
              key: "output",
              align: "right",
              render: (_, row) => compactTokens(row.output_tokens),
            },
            {
              title: "New input",
              key: "input",
              align: "right",
              render: (_, row) => compactTokens(row.input_tokens),
            },
            {
              title: "Cache read",
              key: "cached",
              align: "right",
              render: (_, row) => compactTokens(row.cached_input_tokens),
            },
            {
              title: "Cache write",
              key: "write",
              align: "right",
              render: (_, row) => compactTokens(row.cache_write_tokens),
            },
          ]}
        />
        {report?.truncated && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Only the busiest are shown.
          </Typography.Text>
        )}
      </div>
    </Modal>
  );
}

/** Opens the usage table. Not in CoCalc Plus, which records no usage yet. */
export function AgentUsageButton({ size }: { size?: "small" | "middle" }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // The dialog is mounted only while open, so antd does not restore focus:
  // return it to this button once the dialog is gone.
  useEffect(() => {
    if (wasOpen.current && !open) button.current?.focus();
    wasOpen.current = open;
  }, [open]);
  if (lite) return null;
  return (
    <>
      <Button ref={button} size={size} onClick={() => setOpen(true)}>
        Usage by agent
      </Button>
      {open && <AgentUsageModal open onClose={() => setOpen(false)} />}
    </>
  );
}
