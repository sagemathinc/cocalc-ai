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
  logProjectId?: string;
  logEnabled?: boolean;
  activityContext?: ActivityLogContext;
  onJumpToBottom?: () => void;
  onEventsChange?: (eventCount: number) => void;
  onDeleteEvents?: () => void;
  onDeleteAllEvents?: () => void;
  inlineCodeLinks?: InlineCodeLink[];
  virtualizeEntries?: boolean;
  scrollParent?: HTMLElement | null;
  onOpenFileLink?: () => void;
}

export function CodexLogPanel({
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
  logProjectId,
  logEnabled,
  activityContext,
  onJumpToBottom,
  onEventsChange,
  onDeleteEvents,
  onDeleteAllEvents,
  inlineCodeLinks,
  virtualizeEntries = false,
  scrollParent,
  onOpenFileLink,
}: Props) {
  const codexLog = useCodexLog({
    projectId: logProjectId,
    logStore,
    logKey,
    logSubject,
    generating: generating === true,
    enabled: logEnabled,
  });

  const activityEvents: AcpStreamMessage[] =
    (codexLog.events ?? []).length > 0
      ? codexLog.events!
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
        deleteLog: codexLog.deleteLog,
      });
    };
  }, [onDeleteEvents, activityContext, codexLog.deleteLog]);

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
      onDeleteEvents={handleDeleteEvents}
      onDeleteAllEvents={handleDeleteAllEvents}
      inlineCodeLinks={inlineCodeLinks}
      virtualizeEntries={virtualizeEntries}
      scrollParent={scrollParent}
      onOpenFileLink={onOpenFileLink}
    />
  );
}

export default CodexLogPanel;
