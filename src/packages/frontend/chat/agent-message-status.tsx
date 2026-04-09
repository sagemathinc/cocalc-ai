/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Checkbox, Drawer, Tooltip } from "antd";
import { LoadingOutlined } from "@ant-design/icons";
import type { CSSProperties } from "react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import { TimeAgo } from "@cocalc/frontend/components";
import type { InlineCodeLink } from "@cocalc/chat";
import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";
import { COLORS } from "@cocalc/util/theme";
import CodexLogPanel from "./codex-log-panel";
import type { ActivityLogContext } from "./actions/activity-logs";

const activityScrollPositions = new Map<string, number>();
const SCROLL_BOTTOM_SENTINEL = Number.POSITIVE_INFINITY;
const SCROLL_BOTTOM_EPSILON = 1;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}

function getSavedScrollPosition(node: HTMLDivElement): number {
  const maxTop = node.scrollHeight - node.clientHeight;
  if (maxTop > 0 && node.scrollTop >= maxTop - SCROLL_BOTTOM_EPSILON) {
    return SCROLL_BOTTOM_SENTINEL;
  }
  return node.scrollTop;
}

type LogRefs = {
  store?: string;
  key?: string;
  subject?: string;
  liveStream?: string;
};

export type AttachedSteerState = "sending" | "sent" | "queued" | "not-sent";

export interface AttachedSteerMessage {
  messageId: string;
  date: number;
  text: string;
  state: AttachedSteerState;
}

function renderSteerStatus(state: AttachedSteerState) {
  switch (state) {
    case "sending":
      return {
        label: "Sending guidance",
        borderColor: COLORS.BLUE_LLL,
        background: COLORS.BLUE_LLLL,
        pillBackground: COLORS.BLUE_LLL,
        pillColor: COLORS.BLUE_DDD,
      };
    case "queued":
      return {
        label: "Guidance queued",
        borderColor: COLORS.YELL_LL,
        background: COLORS.YELL_LLL,
        pillBackground: COLORS.YELL_LL,
        pillColor: COLORS.BRWN,
      };
    case "not-sent":
      return {
        label: "Guidance not sent",
        borderColor: COLORS.ANTD_BG_RED_M,
        background: COLORS.ANTD_BG_RED_L,
        pillBackground: COLORS.ANTD_BG_RED_M,
        pillColor: "white",
      };
    default:
      return {
        label: "Guidance sent",
        borderColor: COLORS.BLUE_LLL,
        background: COLORS.BLUE_LLLL,
        pillBackground: COLORS.BLUE_LLL,
        pillColor: COLORS.BLUE_DDD,
      };
  }
}

export function AttachedSteerStatusList({
  attachedSteers,
}: {
  attachedSteers?: AttachedSteerMessage[];
}) {
  const steerItems = Array.isArray(attachedSteers) ? attachedSteers : [];
  if (steerItems.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        marginTop: 5,
        marginBottom: 8,
      }}
    >
      {steerItems.map((steer) => {
        const status = renderSteerStatus(steer.state);
        return (
          <div
            key={steer.messageId}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              flexWrap: "wrap",
              padding: "6px 10px",
              borderRadius: 8,
              background: status.background,
              border: `1px solid ${status.borderColor}`,
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "2px 8px",
                borderRadius: 999,
                background: status.pillBackground,
                color: status.pillColor,
                fontSize: 12,
                fontWeight: 600,
                lineHeight: 1.2,
              }}
            >
              {steer.state === "sending" ? (
                <LoadingOutlined spin style={{ fontSize: 12 }} />
              ) : null}
              {status.label}
            </span>
            <span
              style={{
                fontSize: 12,
                color: COLORS.GRAY_D,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                flex: "1 1 220px",
              }}
            >
              {steer.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export const STALE_ACTIVITY_MS = 2 * 60 * 1000;

function formatTimestampTitle(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function resolveLiveRunStartMs({
  startedAtMs,
  date,
}: {
  startedAtMs?: number;
  date: number;
}): number {
  return typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
    ? startedAtMs
    : date;
}

export function describeLastActivity({
  generating,
  lastActivityAtMs,
  now = Date.now(),
}: {
  generating: boolean;
  lastActivityAtMs?: number;
  now?: number;
}): { label?: string; ageMs?: number; stale: boolean } {
  if (!generating) {
    return { label: undefined, ageMs: undefined, stale: false };
  }
  if (
    typeof lastActivityAtMs !== "number" ||
    !Number.isFinite(lastActivityAtMs)
  ) {
    return { label: "Starting...", ageMs: undefined, stale: false };
  }
  const ageMs = Math.max(0, now - lastActivityAtMs);
  return {
    label: `Last activity ${formatElapsed(ageMs)} ago`,
    ageMs,
    stale: ageMs >= STALE_ACTIVITY_MS,
  };
}

interface AgentMessageStatusProps {
  show: boolean;
  generating: boolean;
  durationLabel: string;
  lastActivityAtMs?: number;
  startedAtMs?: number;
  fontSize?: number;
  project_id?: string;
  path?: string;
  activityBasePath?: string;
  date: number;
  logRefs: LogRefs;
  activityContext: ActivityLogContext;
  inlineCodeLinks?: InlineCodeLink[];
  openDrawerToken?: number;
  jumpText?: string;
  jumpToken?: number;
  notifyOnTurnFinish?: boolean;
  onNotifyOnTurnFinishChange?: (checked: boolean) => void;
  onOpenGitBrowser?: () => void;
  onDrawerOpenChange?: (open: boolean) => void;
  logEvents?: AcpStreamMessage[] | null;
  deleteLog?: () => Promise<void>;
  attachedSteers?: AttachedSteerMessage[];
}

interface AgentActivityChipProps {
  generating: boolean;
  durationLabel: string;
  lastActivityAtMs?: number;
  startedAtMs?: number;
  date: number;
  onOpen: () => void;
  style?: CSSProperties;
}

export function AgentActivityChip({
  generating,
  durationLabel,
  lastActivityAtMs,
  startedAtMs,
  date,
  onOpen,
  style,
}: AgentActivityChipProps) {
  const runStartMs = resolveLiveRunStartMs({ startedAtMs, date });
  const lastActivityInfo = useMemo(
    () =>
      describeLastActivity({
        generating,
        lastActivityAtMs,
        now: Date.now(),
      }),
    [generating, lastActivityAtMs, durationLabel],
  );
  const lastActivityColor = lastActivityInfo.stale
    ? COLORS.ORANGE_WARN
    : COLORS.GRAY_D;
  const liveStatusTitle = useMemo(() => {
    const parts: string[] = [];
    if (Number.isFinite(runStartMs) && runStartMs > 0) {
      parts.push(`Running since: ${formatTimestampTitle(runStartMs)}`);
    }
    if (
      typeof lastActivityAtMs === "number" &&
      Number.isFinite(lastActivityAtMs)
    ) {
      parts.push(`Last activity: ${formatTimestampTitle(lastActivityAtMs)}`);
    } else if (generating) {
      parts.push("Last activity: awaiting first event");
    }
    return parts.join("\n");
  }, [runStartMs, lastActivityAtMs, generating]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      title={liveStatusTitle || "View Codex activity log"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        borderRadius: 999,
        background: COLORS.GRAY_LLL,
        border: `1px solid ${COLORS.GRAY_LL}`,
        lineHeight: 1.2,
        cursor: "pointer",
        ...style,
      }}
    >
      {generating ? (
        <LoadingOutlined spin style={{ fontSize: 12, color: COLORS.GRAY_D }} />
      ) : null}
      <span
        style={{
          color: COLORS.GRAY_D,
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        {generating
          ? `Running ${durationLabel}`
          : `Worked for ${durationLabel}`}
      </span>
      {generating && lastActivityInfo.label ? (
        <Tooltip
          title={
            typeof lastActivityAtMs === "number" &&
            Number.isFinite(lastActivityAtMs) ? (
              <span>
                Last backend activity{" "}
                <TimeAgo date={new Date(lastActivityAtMs)} /> at{" "}
                {formatTimestampTitle(lastActivityAtMs)}
              </span>
            ) : (
              "The turn is running, but no Codex activity event has arrived yet."
            )
          }
        >
          <span style={{ color: lastActivityColor, fontSize: 12 }}>
            {lastActivityInfo.label}
          </span>
        </Tooltip>
      ) : null}
      <span
        style={{
          color: COLORS.GRAY_D,
          fontSize: 12,
          textDecoration: "underline",
        }}
      >
        Activity
      </span>
    </div>
  );
}

export function AgentMessageStatus({
  show,
  generating,
  durationLabel,
  lastActivityAtMs,
  startedAtMs,
  fontSize,
  project_id,
  path,
  activityBasePath,
  date,
  logRefs,
  activityContext,
  inlineCodeLinks,
  openDrawerToken,
  jumpText,
  jumpToken,
  onOpenGitBrowser,
  onDrawerOpenChange,
  logEvents,
  deleteLog,
  attachedSteers,
  notifyOnTurnFinish = false,
  onNotifyOnTurnFinishChange,
}: AgentMessageStatusProps) {
  const [showDrawer, setShowDrawer] = useState(false);
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const [activitySize, setActivitySize0] = useState<number>(
    parseInt(localStorage?.acpActivitySize ?? "600"),
  );
  const persistKey = `${(project_id ?? "no-project").slice(0, 8)}:${
    path ?? ""
  }:${date}`;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingRestoreRef = useRef<number | null>(null);
  const restoringRef = useRef(false);
  const [contentVersion, setContentVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const runStartMs = resolveLiveRunStartMs({ startedAtMs, date });
  const liveDurationLabel = useMemo(() => {
    if (!generating) return durationLabel;
    if (!Number.isFinite(runStartMs) || runStartMs <= 0) return durationLabel;
    return formatElapsed(Date.now() - runStartMs);
  }, [runStartMs, durationLabel, generating, tick]);
  const setActivitySize = (size: number) => {
    setActivitySize0(size);
    try {
      localStorage.acpActivitySize = size;
    } catch {}
  };
  const handleDrawerClose = () => {
    const node = scrollRef.current;
    if (node) {
      activityScrollPositions.set(persistKey, getSavedScrollPosition(node));
    }
    pendingRestoreRef.current = null;
    setShowDrawer(false);
  };
  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    if (restoringRef.current) return;
    activityScrollPositions.set(persistKey, getSavedScrollPosition(node));
    pendingRestoreRef.current = null;
  };
  const handleJumpToBottom = () => {
    const node = scrollRef.current;
    if (!node) return;
    const maxTop = node.scrollHeight - node.clientHeight;
    restoringRef.current = true;
    node.scrollTop = Math.max(0, maxTop);
    restoringRef.current = false;
    pendingRestoreRef.current = SCROLL_BOTTOM_SENTINEL;
    activityScrollPositions.set(persistKey, SCROLL_BOTTOM_SENTINEL);
  };

  useEffect(() => {
    if (!generating) return;
    const handle = window.setInterval(() => {
      setTick((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(handle);
  }, [generating]);

  useEffect(() => {
    if (!showDrawer) return;
    const saved = activityScrollPositions.get(persistKey);
    pendingRestoreRef.current = saved ?? null;
  }, [persistKey, showDrawer]);

  useEffect(() => {
    if (!showDrawer) return;
    setScrollParent(scrollRef.current);
  }, [showDrawer, contentVersion]);

  useEffect(() => {
    if (!showDrawer) return;
    if (typeof requestAnimationFrame === "function") {
      let frame: number | undefined;
      let cancelled = false;
      const deadline = Date.now() + 1500;
      const attemptRestore = () => {
        if (cancelled) return;
        const node = scrollRef.current;
        const target = pendingRestoreRef.current;
        if (!node || target == null) return;
        const maxTop = node.scrollHeight - node.clientHeight;
        const wantsBottom = target === SCROLL_BOTTOM_SENTINEL;
        if (!wantsBottom && maxTop < target && Date.now() < deadline) {
          frame = requestAnimationFrame(attemptRestore);
          return;
        }
        const nextTop = wantsBottom
          ? Math.max(0, maxTop)
          : Math.min(target, Math.max(0, maxTop));
        restoringRef.current = true;
        node.scrollTop = nextTop;
        frame = requestAnimationFrame(() => {
          restoringRef.current = false;
          if (wantsBottom && Date.now() < deadline) {
            frame = requestAnimationFrame(attemptRestore);
            return;
          }
          pendingRestoreRef.current = null;
          activityScrollPositions.set(persistKey, getSavedScrollPosition(node));
        });
      };
      frame = requestAnimationFrame(attemptRestore);
      return () => {
        cancelled = true;
        if (frame != null) cancelAnimationFrame(frame);
      };
    }
    const node = scrollRef.current;
    const target = pendingRestoreRef.current;
    if (!node || target == null) return;
    const maxTop = node.scrollHeight - node.clientHeight;
    const nextTop =
      target === SCROLL_BOTTOM_SENTINEL
        ? Math.max(0, maxTop)
        : Math.min(target, Math.max(0, maxTop));
    restoringRef.current = true;
    node.scrollTop = nextTop;
    restoringRef.current = false;
    pendingRestoreRef.current = null;
    activityScrollPositions.set(persistKey, getSavedScrollPosition(node));
  }, [persistKey, showDrawer, contentVersion]);

  useEffect(() => {
    if (!show) return;
    if (typeof openDrawerToken !== "number" || openDrawerToken <= 0) return;
    setShowDrawer(true);
  }, [show, openDrawerToken]);

  useEffect(() => {
    onDrawerOpenChange?.(showDrawer);
  }, [onDrawerOpenChange, showDrawer]);

  if (!show) return null;

  const openActivity = () => setShowDrawer(true);

  return (
    <>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <AgentActivityChip
          generating={generating}
          durationLabel={liveDurationLabel}
          lastActivityAtMs={lastActivityAtMs}
          startedAtMs={startedAtMs}
          date={date}
          onOpen={openActivity}
        />
        {generating && onNotifyOnTurnFinishChange ? (
          <Tooltip title="Show a modal in this browser tab when this Codex turn finishes.">
            <span
              title="Show a modal in this browser tab when this Codex turn finishes."
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              <Checkbox
                checked={notifyOnTurnFinish}
                onChange={(e) => onNotifyOnTurnFinishChange(e.target.checked)}
              >
                Notify
              </Checkbox>
            </span>
          </Tooltip>
        ) : null}
      </div>
      <AttachedSteerStatusList attachedSteers={attachedSteers} />

      <Drawer
        title={
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>Codex activity</span>
            {onOpenGitBrowser ? (
              <Button
                size="small"
                onClick={() => {
                  handleDrawerClose();
                  onOpenGitBrowser();
                }}
              >
                Open git browser
              </Button>
            ) : null}
          </div>
        }
        placement="right"
        open={showDrawer}
        onClose={handleDrawerClose}
        destroyOnHidden
        size={activitySize}
        resizable={{
          onResize: setActivitySize,
        }}
      >
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{ height: "100%", overflowY: "auto" }}
        >
          <CodexLogPanel
            generating={generating === true}
            fontSize={fontSize}
            persistKey={persistKey}
            basePath={activityBasePath}
            chatPath={path}
            logStore={logRefs.store}
            logKey={logRefs.key}
            logSubject={logRefs.subject}
            liveLogStream={logRefs.liveStream}
            logProjectId={project_id}
            logEnabled={showDrawer}
            events={logEvents}
            activityContext={activityContext}
            onJumpToBottom={handleJumpToBottom}
            jumpText={jumpText}
            jumpToken={jumpToken}
            onEventsChange={() => setContentVersion((prev) => prev + 1)}
            durationLabel={liveDurationLabel}
            projectId={project_id}
            inlineCodeLinks={inlineCodeLinks}
            virtualizeEntries
            scrollParent={scrollParent}
            onOpenFileLink={handleDrawerClose}
            deleteLog={deleteLog}
          />
        </div>
      </Drawer>
    </>
  );
}
