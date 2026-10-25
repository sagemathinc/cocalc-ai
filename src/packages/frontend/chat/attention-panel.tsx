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

import { Button } from "antd";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AcpAttentionRecord } from "@cocalc/conat/ai/acp/types";
import { Icon, Tooltip } from "@cocalc/frontend/components";
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
 * A question its turn outlived, still unanswered: it can be answered as a new
 * message (the card says so), so it still waits for the person.
 */
export function isLateQuestion(record: AcpAttentionRecord): boolean {
  return (
    record.state === "stale" &&
    record.source_kind === "codex_sync_question" &&
    record.response_submitted_at == null
  );
}

/** What still waits for the person to answer: open, or a late question. */
export function isWaitingAttention(record: AcpAttentionRecord): boolean {
  return isOpenAttention(record) || isLateQuestion(record);
}

/** A question whose saved answer did not reach the agent: retried here. */
export function isFailedDelivery(
  record: AcpAttentionRecord,
  projected: ReadonlySet<string>,
): boolean {
  return (
    record.state === "stale" &&
    // Answered and saved: a question that went stale unanswered is just over.
    record.response_submitted_at != null &&
    ["codex_sync_question", "codex_async_question"].includes(
      record.source_kind,
    ) &&
    !projected.has(record.attention_id)
  );
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
      isWaitingAttention(record) ||
      isFailedDelivery(record, projected) ||
      (!projected.has(record.attention_id) &&
        drafts[record.attention_id]?.submitted != null),
  );
}

/** The one way to the panel: plain to see while anything waits. */
export function AttentionPanelButton({
  open: openRecords,
  failed = [],
  onOpen,
}: {
  /** The open requests. */
  open: readonly AcpAttentionRecord[];
  /** Answers that did not reach the agent, to send again. */
  failed?: readonly AcpAttentionRecord[];
  onOpen: () => void;
}) {
  const count = openRecords.length;
  const total = count + failed.length;
  if (total <= 0) return null;
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
      aria-label={`${total} ${total === 1 ? "request waits" : "requests wait"} for you: open them`}
      style={{
        position: "absolute",
        right: 16,
        bottom: 12,
        zIndex: 12,
        boxShadow: `0 2px 10px ${UI_COLORS.shadow}`,
      }}
    >
      {count <= 0
        ? failed.length === 1
          ? "Answer not delivered"
          : `${failed.length} answers not delivered`
        : failed.length === 0 && questions
          ? `${count} ${count === 1 ? "question" : "questions"} waiting`
          : `${total} waiting for you`}
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
  top = 0,
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
  /** Where it starts: below the chat's own toolbar. */
  top?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Kept while the panel is hidden (it stays mounted).
  const [drafts, setDrafts] = useState<Record<string, CodexAttentionDraft>>({});
  const [width, setWidth] = useState(storedWidth);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shown = attentionPanelRecords(records, drafts, projected);
  // What still needs the person: open ones and undelivered answers.
  const actionable = shown.filter(
    (record) =>
      isWaitingAttention(record) || isFailedDelivery(record, projected),
  ).length;
  // At most as wide as the chat it covers: its parent, which is laid out
  // even while the panel is hidden, measured as it changes.
  const [chatWidth, setChatWidth] = useState<number>();
  useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!parent) return;
    const measure = () => setChatWidth(parent.clientWidth || undefined);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const maxWidth = Math.max(
    MIN_WIDTH,
    chatWidth ?? (typeof window === "undefined" ? 2000 : window.innerWidth),
  );
  const clamp = (value: number) =>
    Math.min(maxWidth, Math.max(MIN_WIDTH, value));
  const shownWidth = clamp(width);

  useEffect(() => {
    if (!open) return;
    // Opened: the keys go into it, to the request it was opened for.
    if (!focusAttentionId) {
      panelRef.current?.focus({ preventScroll: true });
      return;
    }
    const card = [
      ...(bodyRef.current?.querySelectorAll<HTMLElement>(
        "[data-codex-attention-id]",
      ) ?? []),
    ].find(({ dataset }) => dataset.codexAttentionId === focusAttentionId);
    card?.scrollIntoView?.({ block: "nearest" });
    (card ?? panelRef.current)?.focus({ preventScroll: true });
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
    const startWidth = shownWidth;
    let next = startWidth;
    const move = (e: PointerEvent) => {
      next = clamp(startWidth + (startX - e.clientX));
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
  // The same with the keys: left widens it, right narrows it.
  const resizeWithKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 80 : 24;
    const change =
      event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
    if (!change) return;
    event.preventDefault();
    const next = clamp(shownWidth + change);
    setWidth(next);
    try {
      localStorage.setItem(WIDTH_KEY, `${Math.round(next)}`);
    } catch {
      // This session only.
    }
  };

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="complementary"
      aria-label="Waiting for you"
      hidden={!open}
      style={{
        position: "absolute",
        top,
        right: 0,
        bottom: 0,
        width: shownWidth,
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
        aria-label="Resize the panel (left and right arrow keys)"
        aria-valuenow={Math.round(shownWidth)}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={Math.round(maxWidth)}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={resizeWithKeys}
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
          {actionable ? ` (${actionable})` : ""}
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
