import { useEffect, useMemo, useRef } from "react";
import type { InlineCodeLink } from "@cocalc/chat";
import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";
import CodexActivity from "./codex-activity";
import {
  deleteActivityLog,
  deleteAllActivityLogs,
  type ActivityLogContext,
} from "./actions/activity-logs";
import { useCodexLog } from "./use-codex-log";

interface Props {
  events?: AcpStreamMessage[] | null;
  generating?: boolean;
  fontSize?: number;
  persistKey: string;
  basePath?: string;
  chatPath?: string;
  durationLabel?: string;
  projectId?: string;
  logStore?: string;
  logKey?: string;
  logSubject?: string;
  liveLogStream?: string;
  logProjectId?: string;
  logEnabled?: boolean;
  activityContext?: ActivityLogContext;
  onJumpToBottom?: () => void;
  jumpText?: string;
  jumpToken?: number;
  onEventsChange?: (eventCount: number) => void;
  onDeleteEvents?: () => void;
  onDeleteAllEvents?: () => void;
  inlineCodeLinks?: InlineCodeLink[];
  onOpenFileLink?: () => void;
  deleteLog?: () => Promise<void>;
}

export function CodexLogPanel({
  events,
  generating,
  fontSize,
  persistKey,
  basePath,
  chatPath,
  durationLabel,
  projectId,
  logStore,
  logKey,
  logSubject,
  liveLogStream,
  logProjectId,
  logEnabled,
  activityContext,
  onJumpToBottom,
  jumpText,
  jumpToken,
  onEventsChange,
  onDeleteEvents,
  onDeleteAllEvents,
  inlineCodeLinks,
  onOpenFileLink,
  deleteLog,
}: Props) {
  const codexLog = useCodexLog({
    projectId: logProjectId,
    logStore,
    logKey,
    logSubject,
    liveLogStream,
    generating: generating === true,
    enabled: events == null && logEnabled,
  });
  const resolvedEvents = events ?? codexLog.events;
  const resolvedDeleteLog = deleteLog ?? codexLog.deleteLog;

  const activityEvents: AcpStreamMessage[] =
    (resolvedEvents ?? []).length > 0
      ? resolvedEvents!
      : generating
        ? [
            {
              type: "event",
              event: { type: "thinking", text: "" },
              seq: 0,
            },
          ]
        : [];
  const lastEmittedCount = useRef<number | null>(null);
  useEffect(() => {
    if (!onEventsChange) return;
    if (lastEmittedCount.current === activityEvents.length) return;
    lastEmittedCount.current = activityEvents.length;
    onEventsChange(activityEvents.length);
  }, [activityEvents.length, onEventsChange]);

  const handleDeleteEvents = useMemo(() => {
    if (onDeleteEvents) return onDeleteEvents;
    if (!activityContext) return undefined;
    return async () => {
      await deleteActivityLog({
        actions: activityContext.actions,
        message: activityContext.message,
        deleteLog: resolvedDeleteLog,
      });
    };
  }, [onDeleteEvents, activityContext, resolvedDeleteLog]);

  const handleDeleteAllEvents = useMemo(() => {
    if (onDeleteAllEvents) return onDeleteAllEvents;
    if (!activityContext) return undefined;
    return async () => {
      await deleteAllActivityLogs(activityContext);
    };
  }, [onDeleteAllEvents, activityContext]);

  return (
    <CodexActivity
      expanded
      events={activityEvents}
      generating={generating === true}
      fontSize={fontSize}
      persistKey={persistKey}
      basePath={basePath}
      chatPath={chatPath}
      durationLabel={durationLabel}
      projectId={projectId}
      onJumpToBottom={onJumpToBottom}
      jumpText={jumpText}
      jumpToken={jumpToken}
      onDeleteEvents={handleDeleteEvents}
      onDeleteAllEvents={handleDeleteAllEvents}
      inlineCodeLinks={inlineCodeLinks}
      onOpenFileLink={onOpenFileLink}
    />
  );
}

export default CodexLogPanel;
