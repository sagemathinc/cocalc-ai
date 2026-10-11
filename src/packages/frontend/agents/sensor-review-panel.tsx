/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// "Review the script" on a proposed sensor: an agent with a clean context
// reads it and says what it does and whether it is safe, so the person
// approving does not have to read code (or copy it into another chat).

import { useEffect, useState } from "react";
import { Alert, Button, Select, Space, Spin, Tag } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type {
  AgentSensor,
  ScriptSensorSpec,
} from "@cocalc/conat/agents/sensors";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  agentReviewer,
  defaultReviewer,
  findSensorReview,
  openSensorReviewChat,
  reviewerOptions,
  sensorReviewChatPath,
  startSensorReview,
  type ReviewerOption,
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
  const [own, setOwn] = useState<ReviewerOption>();
  const [choice, setChoice] = useState<string>();

  // The agent's own model is the default reviewer.
  useEffect(() => {
    let stopped = false;
    agentReviewer(agent).then(
      (reviewer) => !stopped && setOwn(reviewer),
      () => {},
    );
    return () => {
      stopped = true;
    };
  }, [agent.path, agent.thread_id]);

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
          reviewer: choice,
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
  const generating = busy || review?.generating;

  const picker = (
    <Space wrap size={4}>
      <Button
        size="small"
        loading={busy}
        disabled={generating}
        onClick={() => void start()}
      >
        {review ? "Review again" : "Review the script"}
      </Button>
      <span style={{ color: UI_COLORS.secondary }}>with</span>
      <Select
        size="small"
        variant="borderless"
        popupMatchSelectWidth={false}
        loading={!own}
        disabled={generating}
        value={choice ?? (own ? defaultReviewer(own) : undefined)}
        onChange={setChoice}
        options={reviewerOptions(own, agent.name)}
        aria-label="Reviewer model"
      />
    </Space>
  );

  return (
    <section
      aria-label="Script review"
      style={{
        background: UI_COLORS.inset,
        borderRadius: 6,
        padding: "8px 12px",
        margin: "8px 0",
      }}
    >
      {review ? (
        <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
          <Space wrap size={6}>
            {verdict && <Tag color={verdict.color}>{verdict.label}</Tag>}
            {review.generating && <Spin size="small" />}
            <span style={{ color: UI_COLORS.secondary }}>
              {review.generating ? "Reviewing" : "Reviewed"}
              {review.reviewer ? ` by ${review.reviewer}` : ""}
              {review.generating ? "…" : ""}
            </span>
            <Button size="small" type="link" onClick={openThread}>
              Open
            </Button>
          </Space>
          {!review.generating && picker}
        </Space>
      ) : (
        <>
          {picker}
          <div style={{ color: UI_COLORS.secondary, marginTop: 4 }}>
            A new agent that knows nothing else reads the script and tells you
            what it does and whether it is safe. It is told not to run or change
            anything, and never gets more access than @{agent.name}. One turn on
            your account.
          </div>
        </>
      )}
      {error && (
        <Alert type="error" title={error} showIcon style={{ marginTop: 8 }} />
      )}
      {review?.text && (
        <div style={{ marginTop: 8, maxHeight: 360, overflow: "auto" }}>
          <StaticMarkdown value={review.text} />
        </div>
      )}
    </section>
  );
}
