/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What an agent waits for from the person (questions, approvals) is answered
// here, not in the log: a panel over the right of the chat that nothing in
// the log or a new message moves, for every open request in the thread
// whichever turn asked it. Hiding it keeps everything typed so far, so one
// can look things up and come back. It never opens by itself: the button
// says how many wait.

import { Button, Tooltip } from "antd";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { AcpAttentionRecord } from "@cocalc/conat/ai/acp/types";
import { Icon } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  CodexAttentionCard,
  type CodexAttentionDraft,
  type CodexAttentionDraftUpdater,
} from "./codex-attention-card";
import { isOpenAttention } from "./reader-item-log";

const WIDTH_KEY = "cocalc:attention-panel-width";
const DEFAULT_WIDTH = 440;
const MIN_WIDTH = 280;

function storedWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH ? value : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/**
 * The requests the panel lists: open ones, ones answered here (until the
 * answer reaches the log), and questions whose answer failed to reach the
 * agent.
 */
export function attentionPanelRecords(
  records: readonly AcpAttentionRecord[],
  drafts: Record<string, CodexAttentionDraft>,
  projected: ReadonlySet<string>,
): AcpAttentionRecord[] {
  return records.filter(
    (record) =>
      isOpenAttention(record) ||
      (!projected.has(record.attention_id) &&
        (drafts[record.attention_id]?.submitted != null ||
          (record.state === "stale" &&
            ["codex_sync_question", "codex_async_question"].includes(
              record.source_kind,
            )))),
  );
}

/** The one way to the panel: plain to see while anything waits. */
export function AttentionPanelButton({
  open: openRecords,
  onOpen,
}: {
  /** The open requests. */
  open: readonly AcpAttentionRecord[];
  onOpen: () => void;
}) {
  const count = openRecords.length;
  if (count <= 0) return null;
  const questions = openRecords.every(
    (record) =>
      record.questions?.length > 0 || record.source_kind.endsWith("_question"),
  );
  return (
    <Button
      type="primary"
      shape="round"
      icon={<Icon name="question-circle" />}
      onClick={onOpen}
      aria-label={`${count} ${count === 1 ? "request waits" : "requests wait"} for you: open them`}
      style={{
        position: "absolute",
        right: 16,
        bottom: 12,
        zIndex: 12,
        boxShadow: `0 2px 10px ${UI_COLORS.shadow}`,
      }}
    >
      {questions
        ? `${count} ${count === 1 ? "question" : "questions"} waiting`
        : `${count} waiting for you`}
    </Button>
  );
}

export function AttentionPanel({
  records,
  projected,
  open,
  onClose,
  focusAttentionId,
  focusToken,
}: {
  /** The thread's requests. */
  records: readonly AcpAttentionRecord[];
  /** Requests whose answer is already in the log. */
  projected: ReadonlySet<string>;
  open: boolean;
  onClose: () => void;
  /** Scrolled to when the panel opens for it. */
  focusAttentionId?: string;
  focusToken?: number;
}) {
  // Kept while the panel is hidden (it stays mounted).
  const [drafts, setDrafts] = useState<Record<string, CodexAttentionDraft>>({});
  const [width, setWidth] = useState(storedWidth);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shown = attentionPanelRecords(records, drafts, projected);

  useEffect(() => {
    if (!open || !focusAttentionId) return;
    const card = [
      ...(bodyRef.current?.querySelectorAll<HTMLElement>(
        "[data-codex-attention-id]",
      ) ?? []),
    ].find(({ dataset }) => dataset.codexAttentionId === focusAttentionId);
    card?.scrollIntoView?.({ block: "nearest" });
    card?.focus({ preventScroll: true });
  }, [open, focusAttentionId, focusToken]);

  const update = (id: string, change: CodexAttentionDraftUpdater) =>
    setDrafts((current) => ({
      ...current,
      [id]: change(current[id] ?? { selected: {}, other: {} }),
    }));

  // Dragging the left edge resizes it; the width is kept in this browser.
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let next = startWidth;
    const move = (e: PointerEvent) => {
      next = Math.max(MIN_WIDTH, startWidth + (startX - e.clientX));
      setWidth(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(WIDTH_KEY, `${Math.round(next)}`);
      } catch {
        // This session only.
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      role="complementary"
      aria-label="Waiting for you"
      hidden={!open}
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width,
        maxWidth: "100%",
        zIndex: 13,
        display: open ? "flex" : "none",
        flexDirection: "column",
        background: UI_COLORS.surface,
        borderLeft: `1px solid ${UI_COLORS.border}`,
        boxShadow: `-2px 0 12px ${UI_COLORS.shadow}`,
      }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize"
        onPointerDown={startResize}
        style={{
          position: "absolute",
          left: -3,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: "col-resize",
          zIndex: 1,
        }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: `1px solid ${UI_COLORS.border}`,
        }}
      >
        <b style={{ flex: 1 }}>
          Waiting for you
          {shown.length ? ` (${shown.filter(isOpenAttention).length})` : ""}
        </b>
        <Tooltip title="Hide: what you typed is kept">
          <Button
            type="text"
            size="small"
            aria-label="Hide (what you typed is kept)"
            icon={<Icon name="times" />}
            onClick={onClose}
          />
        </Tooltip>
      </div>
      <div
        ref={bodyRef}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}
      >
        {shown.length === 0 ? (
          <div style={{ color: UI_COLORS.muted }}>Nothing waits for you.</div>
        ) : null}
        {shown.map((record) => (
          <div key={record.attention_id} style={{ marginBottom: 12 }}>
            <CodexAttentionCard
              initialRecord={record}
              responseInActivity={projected.has(record.attention_id)}
              draft={drafts[record.attention_id]}
              onDraftChange={(change) => update(record.attention_id, change)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
