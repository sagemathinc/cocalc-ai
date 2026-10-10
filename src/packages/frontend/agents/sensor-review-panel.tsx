/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// "Review" on a proposed script: an agent with a clean context reads it and
// says what it does and whether it is safe, so the person approving does not
// have to read code (or copy it into another chat).

import { useEffect, useState } from "react";
import { Alert, Button, Select, Space, Spin, Tag } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type {
  AgentSensor,
  ScriptSensorSpec,
} from "@cocalc/conat/agents/sensors";
import { DEFAULT_CODEX_MODELS } from "@cocalc/util/ai/codex";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  findSensorReview,
  openSensorReviewChat,
  sensorReviewChatPath,
  startSensorReview,
  type ReviewVerdict,
  type SensorReview,
} from "./sensor-review";

const VERDICT: Record<ReviewVerdict, { color: string; label: string }> = {
  safe: { color: "green", label: "Looks safe" },
  concerns: { color: "gold", label: "Has concerns" },
  reject: { color: "red", label: "Do not approve" },
};

const POLL_MS = 4_000;

export function SensorReviewPanel({
  agent,
  sensor,
  spec,
  hash,
}: {
  agent: NamedAgent;
  sensor: AgentSensor;
  spec: ScriptSensorSpec;
  hash: string;
}) {
  const account_id = useTypedRedux("account", "account_id");
  const [review, setReview] = useState<SensorReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [model, setModel] = useState<string>();
  const codex = agent.runtime?.kind !== "acp";

  // An earlier review of this exact spec, and progress while one runs.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      try {
        const actions = await openSensorReviewChat(
          sensor.project_id,
          sensor.sensor_id,
        );
        if (stopped || !actions) return;
        const found = findSensorReview(actions, spec.title, hash, account_id);
        if (stopped) return;
        setReview(found);
        if (found?.generating) timer = setTimeout(() => void look(), POLL_MS);
      } catch {
        // No review chat yet, or it is not readable: offer to start one.
      }
    };
    void look();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [sensor.project_id, sensor.sensor_id, hash, busy]);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      setReview(
        await startSensorReview({
          agent,
          sensor,
          spec,
          hash,
          account_id,
          model,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setBusy(false);
    }
  };
  const openThread = () =>
    redux.getProjectActions(sensor.project_id)?.open_file({
      path: sensorReviewChatPath(sensor.project_id, sensor.sensor_id),
    });
  const verdict = review?.verdict ? VERDICT[review.verdict] : undefined;

  return (
    <div
      aria-label="Agent review"
      style={{
        border: `1px solid ${UI_COLORS.border}`,
        borderRadius: 6,
        padding: 8,
        margin: "8px 0",
      }}
    >
      <Space wrap>
        <strong>Agent review</strong>
        {verdict && <Tag color={verdict.color}>{verdict.label}</Tag>}
        {review?.generating && (
          <>
            <Spin size="small" /> Reviewing…
          </>
        )}
        {codex && (
          <Select
            size="small"
            style={{ minWidth: 180 }}
            placeholder="The agent's model"
            allowClear
            value={model}
            onChange={setModel}
            options={DEFAULT_CODEX_MODELS.map(({ name }) => ({
              value: name,
              label: name,
            }))}
            aria-label="Model for the review"
          />
        )}
        <Button
          size="small"
          loading={busy}
          disabled={review?.generating}
          onClick={() => void start()}
        >
          {review ? "Review again" : `Review with @${agent.name}'s settings`}
        </Button>
        {review && (
          <Button size="small" type="link" onClick={openThread}>
            Open review
          </Button>
        )}
      </Space>
      {!review && !busy && (
        <div style={{ color: UI_COLORS.secondary, marginTop: 6 }}>
          A fresh agent, with no context but this sensor, reads the script and
          tells you what it does and whether it is safe. It does not run it. The
          review is a turn paid like the agent's.
        </div>
      )}
      {error && (
        <Alert type="error" title={error} showIcon style={{ marginTop: 8 }} />
      )}
      {review?.text && (
        <div style={{ marginTop: 8, maxHeight: 360, overflow: "auto" }}>
          <StaticMarkdown value={review.text} />
        </div>
      )}
    </div>
  );
}
