/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// cSpell:ignore blankcolumn

import {
  Badge,
  Button,
  Col,
  Divider,
  Drawer,
  Modal,
  Row,
  Tag,
  Tooltip,
  message as antdMessage,
} from "antd";
import { CSSProperties, ReactNode, useEffect, useLayoutEffect } from "react";
import { useIntl } from "react-intl";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import {
  CSS,
  redux,
  useMemo,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import { Gap, Icon, TimeAgo, Tip } from "@cocalc/frontend/components";
import CopyButton from "@cocalc/frontend/components/copy-button";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { IS_TOUCH } from "@cocalc/frontend/feature";
import { useEffectiveEditorThemeForPath } from "@cocalc/frontend/project/workspaces/use-effective-editor-theme";
import { modelToName } from "@cocalc/frontend/frame-editors/llm/llm-selector";
import { labels } from "@cocalc/frontend/i18n";
import { CancelText } from "@cocalc/frontend/i18n/components";
import { User } from "@cocalc/frontend/users";
import { isLanguageModelService } from "@cocalc/util/db-schema/llm-utils";
import { unreachable } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { isCodexModelName } from "@cocalc/util/ai/codex";
import {
  deriveAcpLogRefs,
  getBestResponseText,
  getInterruptedResponseMarkdown,
  getLiveResponseMarkdown,
  type InlineCodeLink,
} from "@cocalc/chat";
import { ChatActions } from "./actions";
import { getUserName } from "./chat-log";
import { codexEventsToMarkdown } from "./codex-activity";
import {
  cancelQueuedAcpTurn,
  resetAcpThreadState,
  sendQueuedAcpTurnImmediately,
} from "./acp-api";
import { History, HistoryFooter, HistoryTitle } from "./history";
import { resolveAgentSessionIdForThread } from "./thread-session";
import ChatInput from "./input";
import { FeedbackLLM } from "./llm-msg-feedback";
import { RegenerateLLM } from "./llm-msg-regenerate";
import { SummarizeThread } from "./llm-msg-summarize";
import { Name } from "./name";
import { Time } from "./time";
import { ChatMessageTyped, Mode, SubmitMentionsFn } from "./types";
import {
  getThreadRootDate,
  is_editing,
  message_colors,
  newest_content,
  sender_is_viewer,
  stableDraftKeyFromThreadKey,
  toMsString,
} from "./utils";
import {
  dateValue,
  field,
  historyArray,
  parentMessageId,
  editingArray,
} from "./access";
import { SyncOutlined } from "@ant-design/icons";
import { AgentMessageStatus } from "./agent-message-status";
import { useCodexLog } from "./use-codex-log";
import { GitCommitDrawer } from "./git-commit-drawer";
import { findInChatAndOpenFirstResult } from "./find-in-chat";
import { setChatOverlayOpen } from "./drawer-overlay-state";
import { formatTurnDuration } from "./turn-duration";
import { CodexQuotaHelp } from "./codex-quota-help";

const BLANK_COLUMN = (xs) => <Col key={"blankcolumn"} xs={xs}></Col>;

const MARKDOWN_STYLE = undefined;

const BORDER = "2px solid #ccc";

const GIT_COMMIT_LINK_SCHEME = "cocalc-commit://";
const COMMIT_HASH_BOUNDARY_RE = /\b[0-9a-f]{7,40}\b/gi;
const HEAD_REF = "HEAD";
export const ACP_THINKING_PLACEHOLDER = ":robot: Thinking...";

export function resolveThreadMetadataLookup({
  messageThreadId,
  threadRootMs,
}: {
  messageThreadId?: string;
  threadRootMs?: number;
}): {
  threadLookupKey?: string;
  threadId?: string;
} {
  const normalizedThreadId =
    typeof messageThreadId === "string" && messageThreadId.trim().length > 0
      ? messageThreadId.trim()
      : undefined;
  if (normalizedThreadId) {
    return {
      threadLookupKey: normalizedThreadId,
      threadId: normalizedThreadId,
    };
  }
  return {
    threadLookupKey: threadRootMs != null ? `${threadRootMs}` : undefined,
    threadId: undefined,
  };
}

export function resolveForkThreadNavigation({
  actions,
  message,
}: {
  actions?: Pick<ChatActions, "getMessageByDate">;
  message: ChatMessageTyped;
}): {
  threadKey?: string;
  fragment?: string;
  title?: string;
} {
  if (parentMessageId(message) != null) {
    return {};
  }
  const forkedFromRoot = field<string>(message, "forked_from_root_date");
  if (!forkedFromRoot) {
    return {};
  }
  const forkedTitle = field<string>(message, "forked_from_title")?.trim();
  const forkedLatest = field<string>(
    message,
    "forked_from_latest_message_date",
  );
  const rootDate = new Date(forkedFromRoot);
  if (Number.isNaN(rootDate.valueOf())) {
    return {};
  }
  const latestDate = forkedLatest ? new Date(forkedLatest) : undefined;
  const fragmentDate =
    latestDate && !Number.isNaN(latestDate.valueOf()) ? latestDate : rootDate;
  const fragment = toMsString(fragmentDate);
  const resolveThreadId = (date?: Date): string | undefined => {
    if (!date || Number.isNaN(date.valueOf())) return undefined;
    const target = actions?.getMessageByDate?.(date);
    const threadId = field<string>(target, "thread_id");
    return typeof threadId === "string" && threadId.trim().length > 0
      ? threadId.trim()
      : undefined;
  };
  return {
    threadKey: resolveThreadId(latestDate) ?? resolveThreadId(rootDate),
    fragment,
    title: forkedTitle,
  };
}

const THREAD_STYLE_SINGLE: CSS = {
  marginLeft: "15px",
  marginRight: "15px",
  paddingLeft: "15px",
} as const;

const THREAD_STYLE: CSS = {
  ...THREAD_STYLE_SINGLE,
  borderLeft: BORDER,
  borderRight: BORDER,
} as const;

const THREAD_STYLE_BOTTOM: CSS = {
  ...THREAD_STYLE,
  borderBottomLeftRadius: "10px",
  borderBottomRightRadius: "10px",
  borderBottom: BORDER,
  marginBottom: "10px",
} as const;

const THREAD_STYLE_TOP: CSS = {
  ...THREAD_STYLE,
  borderTop: BORDER,
  borderTopLeftRadius: "10px",
  borderTopRightRadius: "10px",
  marginTop: "10px",
} as const;

const MARGIN_TOP_VIEWER = "17px";

const AVATAR_MARGIN_LEFTRIGHT = "15px";

const VIEWER_MESSAGE_LEFT_MARGIN = "clamp(12px, 15%, 150px)";
const VIEWER_ONLY_STATES = new Set(["queue", "sending", "sent", "not-sent"]);

function linkifyCommitHashes(text: string): string {
  if (!text || !/[0-9a-f]{7,40}/i.test(text)) return text;
  const fencedChunks = text.split(/(```[\s\S]*?```)/g);
  return fencedChunks
    .map((chunk, idx) => {
      if (idx % 2 === 1) return chunk;
      const inlineChunks = chunk.split(/(`[^`\n]*`)/g);
      return inlineChunks
        .map((part, jdx) => {
          if (jdx % 2 === 1) {
            // Inline code span. If it is exactly a git hash, keep the code
            // appearance while making it clickable.
            const m = /^`([0-9a-f]{7,40})`$/i.exec(part);
            if (!m) return part;
            const hash = m[1];
            return [`[\`${hash}\`](${GIT_COMMIT_LINK_SCHEME}${hash})`].join("");
          }
          return part.replace(
            COMMIT_HASH_BOUNDARY_RE,
            (hash, offset: number, source: string) => {
              const before = source[offset - 1] ?? "";
              const after = source[offset + hash.length] ?? "";
              // Don't link hash-like tokens inside URLs/query params/UUIDs.
              if (/[-/=?&#:]/.test(before) || /[-/=?&#:]/.test(after)) {
                return hash;
              }
              return `[${hash}](${GIT_COMMIT_LINK_SCHEME}${hash})`;
            },
          );
        })
        .join("");
    })
    .join("");
}

function parseGitCommitLink(href?: string | null): string | undefined {
  if (!href || !href.startsWith(GIT_COMMIT_LINK_SCHEME)) return undefined;
  const hash = href.slice(GIT_COMMIT_LINK_SCHEME.length).trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) return undefined;
  return hash;
}

function extractFirstCommitMention(text: string): string | undefined {
  if (!text || !/[0-9a-f]{7,40}/i.test(text)) return undefined;
  const re = /\b[0-9a-f]{7,40}\b/gi;
  let match: RegExpExecArray | null = null;
  while ((match = re.exec(text)) != null) {
    const hash = match[0];
    const offset = match.index;
    const before = text[offset - 1] ?? "";
    const after = text[offset + hash.length] ?? "";
    if (/[-/=?&#:]/.test(before) || /[-/=?&#:]/.test(after)) {
      continue;
    }
    return hash.toLowerCase();
  }
  return undefined;
}

export function computeAcpStateToRender({
  acpState,
  latestThreadInterrupted,
  isViewersMessage,
  generating,
  showViewerRunning,
}: {
  acpState?: string;
  latestThreadInterrupted: boolean;
  isViewersMessage: boolean;
  generating?: boolean;
  showViewerRunning?: boolean;
}): string {
  const state =
    acpState === "running" && latestThreadInterrupted ? "" : acpState;
  if (!state) return "";
  if (VIEWER_ONLY_STATES.has(state)) {
    return isViewersMessage ? state : "";
  }
  if (state === "running" && isViewersMessage) {
    return showViewerRunning ? state : "";
  }
  if (isViewersMessage) {
    return "";
  }
  if (state === "running" && !isViewersMessage && generating !== true) {
    return "";
  }
  return state;
}

interface Props {
  index: number;
  actions?: ChatActions;
  get_user_name: (account_id?: string) => string;
  messages;
  message: ChatMessageTyped;
  account_id: string;
  user_map?: Map<string, any>;
  project_id?: string; // improves relative links if given
  path?: string;
  font_size?: number;
  is_prev_sender?: boolean;
  show_avatar?: boolean;
  mode: Mode;

  scroll_into_view?: () => void; // call to scroll this message into view

  // if true, include a reply button - this should only be for messages
  // that don't have an existing reply to them already.
  allowReply?: boolean;

  is_thread?: boolean; // if true, this message belongs to a threaded conversation
  is_thread_body: boolean;

  selected?: boolean;
  threadViewMode?: boolean;
  onForceScrollToBottom?: () => void;

  acpState?: string;
  dim?: boolean;
  searchHighlight?: string;
  openActivityToken?: number;
  onOverlayOpenChange?: (open: boolean) => void;
}

export function resolveEditedMessageForSave(
  mentionSubstituted: string | undefined,
  submittedValue: string | undefined,
  editedValue: string,
): string {
  const fallback = submittedValue ?? editedValue;
  return typeof mentionSubstituted === "string" && mentionSubstituted !== ""
    ? mentionSubstituted
    : fallback;
}

export function resolveRenderedMessageValue({
  rowValue,
  logValue,
  generating,
  interrupted,
}: {
  rowValue: string;
  logValue?: string;
  generating: boolean;
  interrupted?: boolean;
}): string {
  const trimmedRow = rowValue.trim();
  if (
    interrupted &&
    trimmedRow.length > 0 &&
    trimmedRow !== ACP_THINKING_PLACEHOLDER
  ) {
    return rowValue;
  }
  if (
    typeof logValue === "string" &&
    logValue.trim().length > 0 &&
    (interrupted ||
      generating ||
      trimmedRow.length === 0 ||
      trimmedRow === ACP_THINKING_PLACEHOLDER)
  ) {
    return logValue;
  }
  return rowValue;
}

export function shouldSuppressAcpPlaceholderBody({
  value,
  showCodexActivity,
}: {
  value: string;
  showCodexActivity: boolean;
}): boolean {
  return showCodexActivity && value.trim() === ACP_THINKING_PLACEHOLDER;
}

export function resolveEffectiveGenerating({
  isCodexThread,
  generating,
  acpInterrupted,
}: {
  isCodexThread: boolean;
  generating?: boolean;
  acpInterrupted: boolean;
}): boolean {
  if (!isCodexThread) return generating === true;
  if (acpInterrupted) return false;
  return generating === true;
}

function getLatestCodexActivityAtMs(
  events: any[] | null | undefined,
): number | undefined {
  if (!Array.isArray(events)) return undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const time = (events[i] as any)?.time;
    if (typeof time === "number" && Number.isFinite(time)) {
      return time;
    }
  }
  return undefined;
}

export function getFocusMessageButtonStyle(): CSSProperties {
  return {
    color: COLORS.GRAY_M,
    fontSize: "12px",
  };
}

export default function Message({
  index,
  actions,
  get_user_name,
  messages,
  message,
  account_id,
  user_map,
  project_id,
  path,
  font_size,
  is_prev_sender,
  show_avatar,
  mode,
  scroll_into_view,
  allowReply,
  is_thread,
  is_thread_body,
  selected,
  threadViewMode = false,
  onForceScrollToBottom,
  acpState,
  dim,
  searchHighlight,
  openActivityToken,
  onOverlayOpenChange,
}: Props) {
  const intl = useIntl();
  const editorTheme = useEffectiveEditorThemeForPath(project_id, path);

  const showAISummarize = redux
    .getStore("projects")
    .hasLanguageModelEnabled(project_id, "chat-summarize");

  const [edited_message, set_edited_message] = useState<string>(
    newest_content(message),
  );
  // We have to use a ref because of trickiness involving
  // stale closures when submitting the message.
  const edited_message_ref = useRef(edited_message);

  const [show_history, set_show_history] = useState(false);

  const historyEntries = useMemo(() => historyArray(message), [message]);
  const firstHistoryEntry = useMemo(
    () => (historyEntries.length > 0 ? historyEntries[0] : undefined),
    [historyEntries],
  );
  const editingState = useMemo(() => editingArray(message), [message]);

  const new_changes = useMemo(
    () => edited_message !== newest_content(message),
    [edited_message, message],
  );

  // date as ms since epoch or 0
  const date: number = useMemo(() => {
    return dateValue(message)?.valueOf() ?? 0;
  }, [message]);

  const generating = field<boolean>(message, "generating");

  const history_size = historyEntries.length;

  const isEditing = useMemo(
    () => is_editing(message, account_id),
    [message, account_id],
  );
  const showEditButton =
    project_id != null && path != null && actions != null && !isEditing;

  const editor_name = useMemo(() => {
    return get_user_name(firstHistoryEntry?.author_id);
  }, [firstHistoryEntry, get_user_name]);

  const reverseRowOrdering =
    !is_thread_body && sender_is_viewer(account_id, message);

  const submitMentionsRef = useRef<SubmitMentionsFn>(null as any);

  const [replying, setReplying] = useState<boolean>(() => {
    if (!allowReply) {
      return false;
    }
    const replyThreadKey =
      `${field<string>(message, "thread_id") ?? ""}`.trim() || `${date}`;
    const replyDate = stableDraftKeyFromThreadKey(replyThreadKey);
    const draft = actions?.syncdb?.get_one({
      event: "draft",
      sender_id: account_id,
      date: replyDate,
    });
    if (draft == null) {
      return false;
    }
    const active =
      (draft as any)?.get?.("active") ?? (draft as any)?.active ?? undefined;
    if (typeof active === "number" && active <= 1720071100408) {
      // before this point in time, drafts never ever got deleted when sending replies!  So there's a massive
      // clutter of reply drafts sitting in chats, and we don't want to resurrect them.
      return false;
    }
    return true;
  });
  useEffect(() => {
    if (!allowReply) {
      setReplying(false);
    }
  }, [allowReply]);

  const [autoFocusReply, setAutoFocusReply] = useState<boolean>(false);
  const [autoFocusEdit, setAutoFocusEdit] = useState<boolean>(false);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [isHovered, setIsHovered] = useState<boolean>(false);
  const [showTouchActions, setShowTouchActions] = useState<boolean>(false);
  const [showZenMessage, setShowZenMessage] = useState<boolean>(false);
  const [interruptRequested, setInterruptRequested] = useState<boolean>(false);
  const [openActivityDrawerToken, setOpenActivityDrawerToken] = useState<
    number | undefined
  >(undefined);
  const [activityJumpText, setActivityJumpText] = useState<string | undefined>(
    undefined,
  );
  const [activityJumpToken, setActivityJumpToken] = useState(0);
  const [isActivityDrawerOpen, setIsActivityDrawerOpen] = useState(false);
  const [openCommitHash, setOpenCommitHash] = useState<string | undefined>(
    undefined,
  );

  const replyMessageRef = useRef<string>("");
  const replyMentionsRef = useRef<SubmitMentionsFn | undefined>(undefined);

  const is_viewers_message = sender_is_viewer(account_id, message);
  const isLLMThread = useMemo(
    () => actions?.isLanguageModelThread(dateValue(message)),
    [message, actions],
  );
  // Thread identity/model now comes from thread_config metadata.
  const isCodexThread =
    typeof isLLMThread === "string" && isCodexModelName(isLLMThread);
  const acpInterrupted = useMemo(
    () => field<boolean>(message, "acp_interrupted") === true,
    [message],
  );
  const acpInterruptedText = useMemo(
    () => field<string>(message, "acp_interrupted_text"),
    [message],
  );
  const acpStartedAtMs = useMemo(() => {
    const value = field<number | string>(message, "acp_started_at_ms");
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return undefined;
  }, [message]);
  const effectiveGenerating = useMemo(() => {
    return resolveEffectiveGenerating({
      isCodexThread,
      generating,
      acpInterrupted,
    });
  }, [acpInterrupted, generating, isCodexThread]);
  const showDeleteButton = showEditButton && !effectiveGenerating;

  useEffect(() => {
    if (isEditing) return;
    const latest = newest_content(message);
    set_edited_message(latest);
    edited_message_ref.current = latest;
  }, [isEditing, message]);

  useEffect(() => {
    const start = acpStartedAtMs ?? date;
    if (effectiveGenerating && start > 0) {
      const update = () => {
        setElapsedMs(Date.now() - start);
      };
      update();
      const handle = window.setInterval(update, 1000);
      return () => window.clearInterval(handle);
    } else {
      setElapsedMs(0);
    }
  }, [effectiveGenerating, acpStartedAtMs, date]);

  useEffect(() => {
    if (!effectiveGenerating || acpInterrupted) {
      setInterruptRequested(false);
    }
  }, [effectiveGenerating, acpInterrupted, date]);

  const elapsedLabel = useMemo(() => {
    if (!elapsedMs || elapsedMs < 0) return "";
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n: number) => n.toString().padStart(2, "0");
    if (hours > 0) {
      return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${minutes}:${pad(seconds)}`;
  }, [elapsedMs]);

  const anyOverlayOpen = isActivityDrawerOpen || openCommitHash != null;
  const overlayKey = `${project_id ?? "no-project"}:${path ?? "no-path"}:${date}`;

  useEffect(() => {
    setChatOverlayOpen(overlayKey, anyOverlayOpen);
    onOverlayOpenChange?.(anyOverlayOpen);
    return () => {
      setChatOverlayOpen(overlayKey, false);
      onOverlayOpenChange?.(false);
    };
  }, [anyOverlayOpen, onOverlayOpenChange, overlayKey]);

  const msgWrittenByLLM = useMemo(() => {
    const author_id = firstHistoryEntry?.author_id;
    return typeof author_id === "string" && isLanguageModelService(author_id);
  }, [firstHistoryEntry]);

  const threadRootMs = useMemo(() => {
    const root = getThreadRootDate({ date, messages });
    const rootMs =
      root?.valueOf?.() ?? (typeof root === "number" ? root : undefined);
    if (Number.isFinite(rootMs)) return rootMs as number;
    return Number.isFinite(date) ? date : undefined;
  }, [date, messages]);

  const messageThreadId = useMemo(() => {
    const id = field<string>(message, "thread_id");
    return typeof id === "string" && id.trim().length > 0
      ? id.trim()
      : undefined;
  }, [message]);

  const threadMessages = useMemo(() => {
    if (!actions || !messageThreadId) return undefined;
    return actions.getMessagesInThread(messageThreadId);
  }, [actions, messageThreadId, messages]);

  const isLastMessageInThread = useMemo(() => {
    if (!threadMessages?.length) return false;
    const latest = threadMessages[threadMessages.length - 1];
    const latestMs = dateValue(latest)?.valueOf();
    return latestMs != null && latestMs === date;
  }, [threadMessages, date]);

  const latestThreadMessage = useMemo(
    () =>
      threadMessages && threadMessages.length > 0
        ? threadMessages[threadMessages.length - 1]
        : undefined,
    [threadMessages],
  );

  const latestThreadInterrupted = useMemo(() => {
    if (!latestThreadMessage) return false;
    return field<boolean>(latestThreadMessage, "acp_interrupted") === true;
  }, [latestThreadMessage]);

  useEffect(() => {
    if (!actions?.store) return;
    if (!acpInterrupted || effectiveGenerating) return;
    if (acpState !== "running") return;
    const messageId = field<string>(message, "message_id");
    if (!messageId) return;
    const keys = new Set<string>([`message:${messageId}`]);
    const threadId = field<string>(message, "thread_id");
    if (threadId) {
      keys.add(`thread:${threadId}`);
    }
    const acpMap = actions.store.get("acpState");
    const hasRunning = Array.from(keys).some(
      (key) => acpMap?.get?.(key) === "running",
    );
    if (!hasRunning) return;
    let next = acpMap;
    for (const key of keys) {
      next = next.delete(key);
    }
    actions.store.setState({
      acpState: next,
    });
  }, [actions, acpInterrupted, effectiveGenerating, acpState, message]);

  // Resolve log identifiers deterministically (shared with backend) so we never
  // invent subjects/keys in multiple places.
  const fallbackLogRefs = useMemo(() => {
    const turn_message_id =
      `${field<string>(message, "message_id") ?? ""}`.trim();
    const normalizedThreadId = `${messageThreadId ?? ""}`.trim();

    const derived =
      project_id && path && normalizedThreadId && turn_message_id
        ? deriveAcpLogRefs({
            project_id,
            path,
            thread_id: normalizedThreadId,
            message_id: turn_message_id,
          })
        : undefined;

    return {
      thread: derived?.thread,
      turn: derived?.turn,
      store: derived?.store,
      key: derived?.key,
      subject: derived?.subject,
    };
  }, [message, project_id, path, messageThreadId]);

  const showCodexActivity = useMemo(() => {
    // Only show for ACP-driven turns (Codex activity). The log identifiers are
    // derived deterministically, but this marker distinguishes ACP turns from
    // other kinds of LLM messages.
    return Boolean(field<string>(message, "acp_account_id"));
  }, [message]);

  useEffect(() => {
    if (!showCodexActivity) return;
    if (typeof openActivityToken !== "number" || openActivityToken <= 0) return;
    setOpenActivityDrawerToken((n) => (n ?? 0) + 1);
  }, [showCodexActivity, openActivityToken]);

  const rowMessageValue = useMemo(() => newest_content(message), [message]);
  const logStore = useMemo(
    () => field<string>(message, "acp_log_store") ?? fallbackLogRefs.store,
    [message, fallbackLogRefs.store],
  );
  const logKey = useMemo(
    () => field<string>(message, "acp_log_key") ?? fallbackLogRefs.key,
    [message, fallbackLogRefs.key],
  );
  const logSubject = useMemo(
    () => field<string>(message, "acp_log_subject") ?? fallbackLogRefs.subject,
    [message, fallbackLogRefs.subject],
  );
  const liveLogStream = useMemo(
    () => field<string>(message, "acp_live_log_stream"),
    [message],
  );
  const loadLogBody = useMemo(() => {
    if (!showCodexActivity || !project_id) return false;
    if (effectiveGenerating) return true;
    if (acpInterrupted) return true;
    return rowMessageValue.trim().length === 0;
  }, [
    showCodexActivity,
    project_id,
    effectiveGenerating,
    acpInterrupted,
    rowMessageValue,
  ]);
  const codexBodyLog = useCodexLog({
    projectId: project_id,
    logStore,
    logKey,
    logSubject,
    liveLogStream,
    generating: effectiveGenerating,
    enabled: loadLogBody,
  });
  const codexBodyValue = useMemo(() => {
    if (
      !Array.isArray(codexBodyLog.events) ||
      codexBodyLog.events.length === 0
    ) {
      return undefined;
    }
    if (effectiveGenerating) {
      return getLiveResponseMarkdown(codexBodyLog.events as any);
    }
    if (acpInterrupted) {
      return getInterruptedResponseMarkdown(
        codexBodyLog.events as any,
        acpInterruptedText,
      );
    }
    return getBestResponseText(codexBodyLog.events as any);
  }, [
    acpInterrupted,
    acpInterruptedText,
    codexBodyLog.events,
    effectiveGenerating,
  ]);
  const lastCodexActivityAtMs = useMemo(
    () => getLatestCodexActivityAtMs(codexBodyLog.events),
    [codexBodyLog.events],
  );
  const renderedMessageValue = useMemo(
    () =>
      resolveRenderedMessageValue({
        rowValue: rowMessageValue,
        logValue: codexBodyValue,
        generating: effectiveGenerating,
        interrupted: acpInterrupted,
      }),
    [acpInterrupted, codexBodyValue, effectiveGenerating, rowMessageValue],
  );
  const renderedMessageMarkdown = useMemo(
    () =>
      is_viewers_message
        ? renderedMessageValue
        : linkifyCommitHashes(renderedMessageValue),
    [is_viewers_message, renderedMessageValue],
  );

  const threadLookup = useMemo(
    () =>
      resolveThreadMetadataLookup({
        messageThreadId,
        threadRootMs,
      }),
    [messageThreadId, threadRootMs],
  );

  const acpThreadId = useMemo(
    () => field<string>(message, "acp_thread_id"),
    [message],
  );

  const threadCodexConfig = useMemo(() => {
    if (threadLookup.threadLookupKey == null) return undefined;
    return (
      actions?.getThreadMetadata(threadLookup.threadLookupKey, {
        threadId: threadLookup.threadId,
      })?.acp_config ?? undefined
    );
  }, [actions, threadLookup]);

  // Prefer the persisted sessionId from the thread_id-indexed thread config;
  // fall back to the latest assistant-row acp_thread_id, then the message
  // payload, then the legacy date-key/thread key.
  const sessionIdForInterrupt = useMemo(() => {
    const resolved = resolveAgentSessionIdForThread({
      actions,
      threadId: threadLookup.threadId,
      threadKey: threadLookup.threadLookupKey ?? "",
      persistedSessionId: threadCodexConfig?.sessionId,
    });
    return acpThreadId ?? resolved;
  }, [actions, threadCodexConfig, acpThreadId, threadLookup]);

  const activityBasePath = useMemo(
    () => threadCodexConfig?.workingDirectory,
    [threadCodexConfig],
  );

  const feedbackMap = useMemo(() => field<any>(message, "feedback"), [message]);

  const isActive =
    selected || isHovered || replying || show_history || isEditing;

  useLayoutEffect(() => {
    if (replying) {
      scroll_into_view?.();
    }
  }, [replying]);

  const durationLabel = effectiveGenerating
    ? elapsedLabel
    : formatTurnDuration({
        startMs: acpStartedAtMs ?? date,
        history: historyEntries,
      });

  function render_editing_status(is_editing: boolean) {
    let text;

    const other_editors = Array.isArray(editingState)
      ? editingState.filter((id) => id !== account_id)
      : [];
    const otherCount = other_editors.length;

    if (is_editing) {
      if (otherCount === 1) {
        // This user and someone else is also editing
        text = (
          <>
            {`WARNING: ${get_user_name(other_editors[0])} is also editing this! `}
            <b>Simultaneous editing of messages is not supported.</b>
          </>
        );
      } else if (otherCount > 1) {
        // Multiple other editors
        text = `${otherCount} other users are also editing this!`;
      } else if (history_size !== historyEntries.length && new_changes) {
        text = `${editor_name} has updated this message. Esc to discard your changes and see theirs`;
      } else {
        if (IS_TOUCH) {
          text = "You are now editing ...";
        } else {
          text = "You are now editing ... Shift+Enter to submit changes.";
        }
      }
    } else {
      if (otherCount === 1) {
        // One person is editing
        text = `${get_user_name(other_editors[0])} is editing this message`;
      } else if (otherCount > 1) {
        // Multiple editors
        text = `${otherCount} people are editing this message`;
      } else if (newest_content(message).trim() === "") {
        text = `Deleted by ${editor_name}`;
      }
    }

    if (text == null) {
      text = `Last edit by ${editor_name}`;
    }

    if (
      !is_editing &&
      otherCount === 0 &&
      newest_content(message).trim() !== ""
    ) {
      const edit = "Last edit ";
      const name = ` by ${editor_name}`;
      const msg_date = firstHistoryEntry?.date;
      return (
        <div
          style={{
            color: COLORS.GRAY_M,
            fontSize: "14px" /* matches Reply button */,
          }}
        >
          {edit}{" "}
          {msg_date != null ? (
            <TimeAgo date={new Date(msg_date)} />
          ) : (
            "unknown time"
          )}{" "}
          {name}
        </div>
      );
    }
    return (
      <div style={{ color: COLORS.GRAY_M }}>
        {text}
        {is_editing ? (
          <span style={{ margin: "10px 10px 0 10px", display: "inline-block" }}>
            <Button onClick={on_cancel}>Cancel</Button>
            <Gap />
            <Button onClick={() => saveEditedMessage()} type="primary">
              Save (shift+enter)
            </Button>
          </span>
        ) : undefined}
      </div>
    );
  }

  function edit_message() {
    if (project_id == null || path == null || actions == null) {
      // no editing functionality or not in a project with a path.
      return;
    }
    actions.setEditing(message, true);
    const latest = newest_content(message);
    set_edited_message(latest);
    edited_message_ref.current = latest;
    setAutoFocusEdit(true);
    scroll_into_view?.();
  }

  function confirm_delete_message() {
    if (!actions) {
      return;
    }
    const preview = newest_content(message).trim().replace(/\s+/g, " ");
    const snippet =
      preview.length > 0
        ? preview.length > 120
          ? `${preview.slice(0, 117)}...`
          : preview
        : null;
    Modal.confirm({
      title: snippet ? `Delete message "${snippet}"?` : "Delete message?",
      content:
        "This removes the message from the current chat for everyone. It remains available in TimeTravel.",
      okText: "Delete",
      okType: "danger",
      cancelText: "Cancel",
      onOk: () => {
        const deleted = actions.deleteMessage(message);
        if (!deleted) {
          antdMessage.error("Deleting this message failed.");
          return;
        }
        antdMessage.success("Message deleted.");
      },
    });
  }

  function avatar_column() {
    const sender_id = field<string>(message, "sender_id");
    let style: CSSProperties = {};
    if (!is_prev_sender) {
      style.marginTop = "22px";
    } else {
      style.marginTop = "5px";
    }

    if (!is_thread_body) {
      if (sender_is_viewer(account_id, message)) {
        style.marginLeft = AVATAR_MARGIN_LEFTRIGHT;
      } else {
        style.marginRight = AVATAR_MARGIN_LEFTRIGHT;
      }
    }

    return (
      <Col key={0} xs={2}>
        <div style={style}>
          {sender_id != null && show_avatar ? (
            <Avatar size={40} account_id={sender_id} />
          ) : undefined}
        </div>
      </Col>
    );
  }

  function renderCopyMessageButton() {
    return (
      <Tip
        placement={"top"}
        title={intl.formatMessage({
          id: "chat.message.copy_markdown.tooltip",
          defaultMessage: "Copy message as markdown",
          description:
            "Tooltip for button to copy chat message as markdown text",
        })}
      >
        <CopyButton
          markdown
          value={message_to_markdown(message, { includeHeader: false })}
          size="small"
          noText={true}
          style={{
            //color: is_viewers_message ? "white" : "#888",
            fontSize: "12px",
            marginTop: "-4px",
          }}
        />
      </Tip>
    );
  }

  function renderLinkMessageButton() {
    return (
      <Tip
        placement={"top"}
        title={intl.formatMessage({
          id: "chat.message.copy_link.tooltip",
          defaultMessage: "Select message. Copy URL to link to this message.",
          description:
            "Tooltip for button to copy URL link to specific chat message",
        })}
      >
        <Button
          onClick={() => {
            const d = dateValue(message);
            if (d != null) {
              actions?.setFragment(d);
            }
          }}
          size="small"
          type={"text"}
          style={{
            //color: is_viewers_message ? "white" : "#888",
            fontSize: "12px",
            marginTop: "-4px",
          }}
        >
          <Icon name="link" />
        </Button>
      </Tip>
    );
  }

  function renderLLMFeedbackButtons() {
    if (isLLMThread) return;

    const feedback =
      typeof feedbackMap?.get === "function"
        ? feedbackMap.get(account_id)
        : feedbackMap?.[account_id];
    const otherFeedback =
      isLLMThread && msgWrittenByLLM
        ? 0
        : typeof feedbackMap?.size === "number"
          ? feedbackMap.size
          : Array.isArray(feedbackMap)
            ? feedbackMap.length
            : feedbackMap && typeof feedbackMap === "object"
              ? Object.keys(feedbackMap).length
              : 0;
    const showOtherFeedback = otherFeedback > 0;

    const iconColor = showOtherFeedback ? "darkblue" : COLORS.GRAY_D;
    return (
      <Tip
        placement={"top"}
        title={
          !showOtherFeedback
            ? "Like this"
            : () => {
                return (
                  <div>
                    {Object.keys(
                      typeof feedbackMap?.toJS === "function"
                        ? feedbackMap.toJS()
                        : (feedbackMap ?? {}),
                    ).map((account_id) => (
                      <div key={account_id} style={{ marginBottom: "2px" }}>
                        <Avatar size={24} account_id={account_id} />{" "}
                        <User account_id={account_id} />
                      </div>
                    ))}
                  </div>
                );
              }
        }
      >
        <Button
          size="small"
          type={feedback ? "dashed" : "text"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            color: iconColor,
          }}
          onClick={() => {
            actions?.feedback(message, feedback ? null : "positive");
          }}
        >
          {showOtherFeedback ? (
            <Badge count={otherFeedback} color="darkblue" size="small">
              <Icon
                name="thumbs-up"
                style={{ color: "darkblue", fontSize: 14 }}
              />
            </Badge>
          ) : (
            <Icon name="thumbs-up" style={{ fontSize: 14, color: iconColor }} />
          )}
        </Button>
      </Tip>
    );
  }

  function renderMessageHeader(lighten) {
    const headerActions = renderHeaderActions();
    return (
      <div
        style={{
          ...lighten,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "4px",
          gap: "10px",
        }}
      >
        <Time message={message} edit={edit_message} />
        {headerActions}
      </div>
    );
  }

  function openGitBrowserFromMessage() {
    const hash = extractFirstCommitMention(renderedMessageValue);
    setOpenCommitHash(hash ?? HEAD_REF);
  }

  function renderHeaderActions() {
    const showActions = isActive;
    if (!showActions && !IS_TOUCH) {
      return null;
    }
    const buttons: ReactNode[] = [];

    const llmFeedbackButton = renderLLMFeedbackButtons();
    if (llmFeedbackButton) {
      buttons.push(<span key="like">{llmFeedbackButton}</span>);
    }
    buttons.push(<span key="copy">{renderCopyMessageButton()}</span>);
    buttons.push(<span key="link">{renderLinkMessageButton()}</span>);

    if (allowReply && !replying && actions) {
      buttons.push(
        <Tooltip
          key="reply"
          placement="bottom"
          title={
            isLLMThread
              ? `Reply to ${modelToName(
                  isLLMThread,
                )}, sending the thread as context.`
              : "Reply to this thread."
          }
        >
          <Button
            type="text"
            size="small"
            style={{ color: COLORS.GRAY_M }}
            onClick={() => {
              setReplying(true);
              setAutoFocusReply(true);
            }}
          >
            <Icon name="reply" /> Reply
            {isLLMThread ? ` to ${modelToName(isLLMThread)}` : ""}
            {isLLMThread ? (
              <Avatar
                account_id={isLLMThread}
                size={16}
                style={{ top: "-2px", marginLeft: "4px" }}
              />
            ) : null}
          </Button>
        </Tooltip>,
      );
    }

    if (showAISummarize && is_thread && !threadViewMode) {
      buttons.push(
        <span key="summarize">
          <SummarizeThread message={message} actions={actions} />
        </span>,
      );
    }

    const historySize = history_size;
    if (historySize > 1) {
      buttons.push(
        <Tip
          key="history"
          title="Message History"
          tip={`${show_history ? "Hide" : "Show"} history of edits.`}
        >
          <Button
            size="small"
            type={show_history ? "primary" : "text"}
            icon={<Icon name="history" />}
            onClick={() => {
              set_show_history(!show_history);
              scroll_into_view?.();
            }}
          >
            {show_history ? "Hide" : "History"}
          </Button>
        </Tip>,
      );
    }

    if (showEditButton) {
      buttons.push(
        <Tip
          key="edit"
          title={
            <>
              Edit this message. You can edit <b>any</b> past message using this
              button. Fix other people's typos. All versions are stored.
            </>
          }
          placement="bottom"
        >
          <Button
            size="small"
            type="text"
            style={{ color: COLORS.GRAY_M }}
            onClick={edit_message}
            icon={<Icon name="pencil" />}
          ></Button>
        </Tip>,
      );
    }

    if (showDeleteButton) {
      buttons.push(
        <Tip
          key="delete"
          title="Delete this message from the current chat. It remains available in TimeTravel."
          placement="bottom"
        >
          <Button
            size="small"
            type="text"
            danger
            onClick={confirm_delete_message}
            icon={<Icon name="trash" />}
          />
        </Tip>,
      );
    }

    if (isCodexThread && !is_viewers_message) {
      buttons.push(
        <Tooltip key="git-browser" placement="bottom" title="Open git browser">
          <Button
            size="small"
            type="text"
            style={{ color: COLORS.GRAY_M }}
            onClick={openGitBrowserFromMessage}
            icon={<Icon name="git" />}
          />
        </Tooltip>,
      );
    }

    if (isLLMThread && msgWrittenByLLM) {
      buttons.push(
        <span key="regenerate">
          <RegenerateLLM actions={actions} date={date} model={isLLMThread} />
        </span>,
      );
      buttons.push(
        <span key="feedback-llm">
          <FeedbackLLM actions={actions} message={message} />
        </span>,
      );
    }
    buttons.push(
      <Tooltip key="focus" placement="top" title="Focus this message">
        <Button
          size="small"
          type="text"
          style={getFocusMessageButtonStyle()}
          onClick={() => setShowZenMessage(true)}
        >
          <Icon name="expand-arrows" />
        </Button>
      </Tooltip>,
    );

    if (!buttons.length) {
      return null;
    }

    if (IS_TOUCH) {
      const toggle = (
        <Button
          size="small"
          type="text"
          style={{ color: COLORS.GRAY_M }}
          onClick={() => setShowTouchActions((prev) => !prev)}
        >
          <Icon name="ellipsis" />
        </Button>
      );
      return (
        <div
          style={{
            position: "absolute",
            right: 0,
            display: "flex",
            alignItems: "center",
            gap: "6px",
            justifyContent: "flex-end",
          }}
        >
          {showTouchActions ? (
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "flex-end",
                gap: "6px",
              }}
            >
              {buttons}
            </div>
          ) : null}
          {toggle}
        </div>
      );
    }

    return (
      <div
        style={{
          position: "absolute",
          right: 0,
          display: "flex",
          alignItems: "center",
          gap: "6px",
          flexWrap: "wrap",
          justifyContent: "flex-end",
        }}
      >
        {buttons}
      </div>
    );
  }

  function renderMessageBody({ message_class }) {
    const value = renderedMessageMarkdown;
    const suppressPlaceholderBody = shouldSuppressAcpPlaceholderBody({
      value,
      showCodexActivity,
    });
    const inlineCodeLinks = field<InlineCodeLink[]>(
      message,
      "inline_code_links",
    );
    const openCommitFromMessage = (e: any) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      const hash = parseGitCommitLink(anchor?.getAttribute("href"));
      if (!hash) return;
      e.preventDefault();
      e.stopPropagation();
      setOpenCommitHash(hash);
    };
    const openActivityFromParagraph = (e: any) => {
      if (!showCodexActivity || !effectiveGenerating) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("a[href]")) return;
      const block = target?.closest?.(
        "p, li, pre, blockquote, h1, h2, h3, h4, h5, h6",
      ) as HTMLElement | null;
      const text = block?.innerText?.replace(/\s+/g, " ").trim() ?? "";
      if (text.length < 6) return;
      setActivityJumpText(text);
      setActivityJumpToken((n) => n + 1);
      setOpenActivityDrawerToken((n) => (n ?? 0) + 1);
    };

    return (
      <>
        {renderForkNotice()}
        <AgentMessageStatus
          show={showCodexActivity}
          generating={effectiveGenerating}
          durationLabel={durationLabel}
          lastActivityAtMs={lastCodexActivityAtMs}
          startedAtMs={acpStartedAtMs}
          fontSize={font_size}
          project_id={project_id}
          path={path}
          activityBasePath={activityBasePath}
          date={date}
          logRefs={{
            store: logStore,
            key: logKey,
            subject: logSubject,
            liveStream: liveLogStream,
          }}
          activityContext={{
            actions,
            message,
            messages,
            threadRootMs,
            threadId: messageThreadId,
            project_id,
            path,
          }}
          inlineCodeLinks={
            Array.isArray(inlineCodeLinks) ? inlineCodeLinks : undefined
          }
          logEvents={codexBodyLog.events as any}
          deleteLog={codexBodyLog.deleteLog}
          openDrawerToken={openActivityDrawerToken}
          jumpText={activityJumpText}
          jumpToken={activityJumpToken}
          onOpenGitBrowser={
            isCodexThread && !is_viewers_message
              ? openGitBrowserFromMessage
              : undefined
          }
          onDrawerOpenChange={setIsActivityDrawerOpen}
        />
        {!suppressPlaceholderBody && value.trim().length > 0 ? (
          <div
            onClickCapture={(e) => {
              openCommitFromMessage(e);
              openActivityFromParagraph(e);
            }}
            title={
              showCodexActivity && effectiveGenerating
                ? "Click a paragraph to open matching Codex activity"
                : undefined
            }
          >
            <StaticMarkdown
              style={MARKDOWN_STYLE}
              value={value}
              className={message_class}
              editorTheme={editorTheme}
              highlightQuery={searchHighlight}
              inlineCodeLinks={
                Array.isArray(inlineCodeLinks) ? inlineCodeLinks : undefined
              }
              inlineCodeProjectRoot={activityBasePath}
            />
            <CodexQuotaHelp message={value} projectId={project_id} />
          </div>
        ) : null}
      </>
    );
  }

  function renderZenMessageDrawer() {
    if (!showZenMessage) return null;
    const value = renderedMessageMarkdown;
    const inlineCodeLinks = field<InlineCodeLink[]>(
      message,
      "inline_code_links",
    );
    const openCommitFromMessage = (e: any) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      const hash = parseGitCommitLink(anchor?.getAttribute("href"));
      if (!hash) return;
      e.preventDefault();
      e.stopPropagation();
      setOpenCommitHash(hash);
    };
    return (
      <Drawer
        title={get_user_name(field(message, "sender_id"))}
        open={showZenMessage}
        onClose={() => setShowZenMessage(false)}
        placement="right"
        width="100vw"
        destroyOnHidden
      >
        <div
          style={{ maxWidth: 960, margin: "0 auto", padding: "0 8px 24px 8px" }}
        >
          <div onClickCapture={openCommitFromMessage}>
            <StaticMarkdown
              style={{ fontSize: `${font_size ?? 14}px` }}
              value={value}
              editorTheme={editorTheme}
              highlightQuery={searchHighlight}
              inlineCodeLinks={
                Array.isArray(inlineCodeLinks) ? inlineCodeLinks : undefined
              }
              inlineCodeProjectRoot={activityBasePath}
            />
          </div>
        </div>
      </Drawer>
    );
  }

  function renderEditingMeta() {
    if (isEditing) {
      return null;
    }
    const showEditingStatus =
      history_size > 1 ||
      (Array.isArray(editingState) && editingState.length > 0);
    if (!showEditingStatus) {
      return null;
    }
    return (
      <div style={{ marginTop: "6px" }}>{render_editing_status(isEditing)}</div>
    );
  }

  function renderBottomControls() {
    if (!effectiveGenerating || actions == null) {
      return null;
    }
    const interruptLabel = isCodexThread
      ? interruptRequested
        ? "Interrupting..."
        : "Interrupt"
      : "Stop Generating";
    const interruptIcon = isCodexThread ? "bolt" : "square";
    return (
      <div
        style={{
          marginTop: "8px",
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: "8px",
          flexWrap: "wrap",
          color: COLORS.GRAY_M,
        }}
      >
        {onForceScrollToBottom ? (
          <Button
            size="small"
            style={{ color: COLORS.GRAY_M }}
            onClick={() => onForceScrollToBottom?.()}
            title="Scroll to newest message and re-enable auto-scroll"
          >
            <Icon name="arrow-down" /> Newest
          </Button>
        ) : null}
        <Button
          size="small"
          style={{ color: COLORS.GRAY_M }}
          disabled={interruptRequested}
          loading={interruptRequested}
          onClick={async () => {
            if (interruptRequested) return;
            setInterruptRequested(true);
            const ok = await actions?.languageModelStopGenerating(
              new Date(date),
              {
                threadId: sessionIdForInterrupt,
                senderId: field<string>(message, "sender_id"),
              },
            );
            if (!ok) {
              setInterruptRequested(false);
              antdMessage.error("Failed to interrupt Codex turn.");
            }
          }}
        >
          <Icon name={interruptIcon} /> {interruptLabel}
        </Button>
        {elapsedLabel ? (
          <span style={{ fontSize: 12, display: "inline-flex", gap: "4px" }}>
            <Icon name="clock" /> {elapsedLabel}
          </span>
        ) : null}
      </div>
    );
  }

  function renderInterruptedControls() {
    if (
      actions == null ||
      !acpInterrupted ||
      effectiveGenerating ||
      !isCodexThread ||
      !isLastMessageInThread
    ) {
      return null;
    }
    if (!messageThreadId) return null;
    return (
      <div
        style={{
          marginTop: "8px",
          display: "flex",
          justifyContent: "flex-start",
          alignItems: "center",
          gap: "8px",
          flexWrap: "wrap",
        }}
      >
        <Button
          size="small"
          onClick={() => {
            resetAcpThreadState({
              actions,
              threadId: messageThreadId,
            });
            actions.sendReply({
              message,
              reply: "continue",
              noNotification: true,
            });
          }}
          title="Ask Codex to continue from this interrupted turn"
        >
          <Icon name="step-forward" /> Continue
        </Button>
      </div>
    );
  }

  function renderForkNotice() {
    const navigation = resolveForkThreadNavigation({ actions, message });
    if (!navigation.fragment) return null;
    return (
      <div style={{ marginBottom: 6 }}>
        <Button
          type="link"
          size="small"
          style={{ padding: 0 }}
          onClick={(event) => {
            event.stopPropagation();
            if (navigation.threadKey) {
              actions?.setSelectedThread?.(navigation.threadKey);
            }
            if (navigation.fragment) {
              // Defer so thread selection doesn't immediately clear the fragment.
              setTimeout(() => actions?.setFragment?.(navigation.fragment), 0);
            }
          }}
        >
          Forked from {navigation.title || "another chat"} →
        </Button>
      </div>
    );
  }

  function contentColumn() {
    const mainXS = mode === "standalone" ? 20 : 22;

    const { background, color, lighten, message_class } = message_colors(
      account_id,
      message,
    );

    const marginTop =
      !is_prev_sender && is_viewers_message ? MARGIN_TOP_VIEWER : "5px";

    const padding = selected
      ? { paddingTop: 6, paddingLeft: 6, paddingRight: 6 }
      : { paddingTop: 9, paddingLeft: 9, paddingRight: 9 };
    const baseBottomPadding = selected ? 6 : 9;
    const messageStyle: CSSProperties = {
      color,
      background,
      wordWrap: "break-word",
      borderRadius: "5px",
      marginTop,
      fontSize: `${font_size}px`,
      paddingBottom: baseBottomPadding,
      ...padding,
      ...(is_viewers_message && mode === "standalone"
        ? { marginLeft: VIEWER_MESSAGE_LEFT_MARGIN }
        : undefined),
      ...(mode === "sidechat"
        ? { marginLeft: "5px", marginRight: "5px" }
        : undefined),
      ...(selected ? { border: "3px solid #66bb6a" } : undefined),
    } as const;

    return (
      <Col key={1} xs={mainXS}>
        <div
          style={{ display: "flex", margin: "10px 0 -10px 0" }}
          onClick={() => {
            const d = dateValue(message);
            if (d != null) actions?.setFragment(d);
          }}
        >
          {!is_prev_sender &&
          !is_viewers_message &&
          field<string>(message, "sender_id") ? (
            <Name sender_name={get_user_name(field(message, "sender_id"))} />
          ) : undefined}
        </div>
        <div style={messageStyle} className="smc-chat-message">
          {renderMessageHeader(lighten)}
          {isEditing
            ? renderEditMessage()
            : renderMessageBody({ message_class })}
          {renderEditingMeta()}
          {renderBottomControls()}
          {renderInterruptedControls()}
        </div>
        {renderHistory()}
        {renderComposeReply()}
      </Col>
    );
  }

  function renderHistory() {
    if (!show_history) return;
    return (
      <div>
        <HistoryTitle />
        <History history={historyEntries} user_map={user_map} />
        <HistoryFooter />
      </div>
    );
  }

  function saveEditedMessage(submittedValue?: string): void {
    if (actions == null) return;
    const mentionSubstituted = submitMentionsRef.current?.({ chat: `${date}` });
    const mesg = resolveEditedMessageForSave(
      mentionSubstituted,
      submittedValue,
      edited_message_ref.current,
    );
    const value = newest_content(message);
    if (mesg !== value) {
      set_edited_message(mesg);
      actions.sendEdit(message, mesg);
    } else {
      actions.setEditing(message, false);
    }
  }

  function on_cancel(): void {
    set_edited_message(newest_content(message));
    if (actions == null) return;
    actions.setEditing(message, false);
    actions.deleteDraft(date);
  }

  function renderEditMessage() {
    if (project_id == null || path == null || actions?.syncdb == null) {
      // should never get into this position
      // when null.
      return;
    }
    return (
      <div>
        <ChatInput
          fontSize={font_size}
          autoFocus={autoFocusEdit}
          cacheId={`${path}${project_id}${date}`}
          input={edited_message}
          submitMentionsRef={submitMentionsRef}
          on_send={(value) => saveEditedMessage(value)}
          height={"auto"}
          syncdb={actions.syncdb}
          date={date}
          onChange={(value) => {
            set_edited_message(value);
            edited_message_ref.current = value;
          }}
        />
        <div style={{ marginTop: "10px", display: "flex" }}>
          <Button
            style={{ marginRight: "5px" }}
            onClick={() => {
              actions?.setEditing(message, false);
              actions?.deleteDraft(date);
            }}
          >
            {intl.formatMessage(labels.cancel)}
          </Button>
          <Button type="primary" onClick={() => saveEditedMessage()}>
            <Icon name="save" /> Save Edited Message
          </Button>
        </div>
      </div>
    );
  }

  function sendReply(reply?: string) {
    if (actions == null) return;
    setReplying(false);
    if (!reply && !replyMentionsRef.current?.(undefined, true)) {
      reply = replyMessageRef.current;
    }
    actions.sendReply({
      message:
        typeof (message as any)?.toJS === "function"
          ? (message as any).toJS()
          : message,
      reply,
      submitMentionsRef: replyMentionsRef,
    });
    actions.scrollToIndex(index);
  }

  function sendGitBrowserAgentPrompt(prompt: string) {
    if (actions == null) return;
    const trimmed = `${prompt ?? ""}`.trim();
    if (!trimmed) return;
    actions.sendReply({
      message:
        typeof (message as any)?.toJS === "function"
          ? (message as any).toJS()
          : message,
      reply: trimmed,
    });
  }

  function logGitBrowserDirectCommit({
    hash,
    subject,
  }: {
    hash: string;
    subject: string;
  }) {
    if (actions == null || !messageThreadId) return;
    const commit = `${hash ?? ""}`.trim();
    if (!commit) return;
    const lines = ["Committed manually.", `Commit: ${commit}`];
    if (`${subject ?? ""}`.trim()) {
      lines.push(`Subject: ${subject.trim()}`);
    }
    actions.sendChat({
      extraInput: lines.join("\n"),
      reply_thread_id: messageThreadId,
      preserveSelectedThread: true,
      skipModelDispatch: true,
    });
  }

  function findCommitInCurrentChat(query: string) {
    if (actions == null || !project_id || !path) return;
    void findInChatAndOpenFirstResult({ actions, project_id, path, query });
    setOpenCommitHash(undefined);
  }

  function openActivityFromGitBrowser() {
    setOpenCommitHash(undefined);
    setOpenActivityDrawerToken((n) => (n ?? 0) + 1);
  }

  function renderComposeReply() {
    if (!replying) return;

    if (project_id == null || path == null || actions?.syncdb == null) {
      // should never get into this position
      // when null.
      return;
    }

    const replyThreadKey = messageThreadId ?? `${date}`;
    const replyDate = stableDraftKeyFromThreadKey(replyThreadKey);
    let input;
    let moveCursorToEndOfLine = false;
    if (isLLMThread) {
      input = "";
    } else {
      const replying_to = firstHistoryEntry?.author_id;
      if (!replying_to || replying_to == account_id) {
        input = "";
      } else {
        input = `<span class="user-mention" account-id=${replying_to} >@${editor_name}</span> `;
        moveCursorToEndOfLine = autoFocusReply;
      }
    }
    return (
      <div style={{ marginLeft: mode === "standalone" ? "30px" : "0" }}>
        <ChatInput
          fontSize={font_size}
          autoFocus={autoFocusReply}
          moveCursorToEndOfLine={moveCursorToEndOfLine}
          style={{
            borderRadius: "8px",
            height: "auto" /* for some reason the default 100% breaks things */,
          }}
          cacheId={`${path}${project_id}${date}-reply`}
          input={input}
          submitMentionsRef={replyMentionsRef}
          on_send={sendReply}
          height={"auto"}
          syncdb={actions.syncdb}
          date={replyDate}
          onChange={(value) => {
            replyMessageRef.current = value;
          }}
          placeholder={"Reply to the above message..."}
        />
        <div style={{ margin: "5px 0", display: "flex" }}>
          <Button
            style={{ marginRight: "5px" }}
            onClick={() => {
              setReplying(false);
              actions?.deleteDraft(replyDate);
            }}
          >
            <CancelText />
          </Button>
          <Tooltip title="Send Reply (shift+enter)">
            <Button
              onClick={() => {
                sendReply();
              }}
              type="primary"
            >
              <Icon name="reply" /> Reply
            </Button>
          </Tooltip>
        </div>
      </div>
    );
  }

  function getStyleBase(): CSS {
    if (threadViewMode) {
      return THREAD_STYLE_SINGLE;
    }
    if (!is_thread_body) {
      if (is_thread) {
        return THREAD_STYLE_TOP;
      } else {
        return THREAD_STYLE_SINGLE;
      }
    } else if (allowReply) {
      return THREAD_STYLE_BOTTOM;
    } else {
      return THREAD_STYLE;
    }
  }

  function getStyle(): CSS {
    switch (mode) {
      case "standalone":
        return {
          ...getStyleBase(),
          opacity: dim ? 0.45 : 1,
        };
      case "sidechat":
        return {
          ...getStyleBase(),
          marginLeft: "5px",
          marginRight: "5px",
          paddingLeft: "0",
          opacity: dim ? 0.45 : 1,
        };
      default:
        unreachable(mode);
        return getStyleBase();
    }
  }

  function renderCols(): React.JSX.Element[] | React.JSX.Element {
    switch (mode) {
      case "standalone":
        const cols = [avatar_column(), contentColumn(), BLANK_COLUMN(2)];
        if (reverseRowOrdering) {
          cols.reverse();
        }
        return cols;

      case "sidechat":
        return [BLANK_COLUMN(2), contentColumn()];

      default:
        unreachable(mode);
        return contentColumn();
    }
  }

  const handleCancelQueued = () => {
    if (!actions) return;
    void cancelQueuedAcpTurn({ actions, message });
  };
  const handleSendQueuedImmediately = () => {
    if (!actions) return;
    void sendQueuedAcpTurnImmediately({ actions, message });
  };

  const acpStateToRender = useMemo(() => {
    return computeAcpStateToRender({
      acpState,
      latestThreadInterrupted,
      isViewersMessage: is_viewers_message,
      generating,
      showViewerRunning: latestThreadMessage == null || isLastMessageInThread,
    });
  }, [
    acpState,
    latestThreadInterrupted,
    is_viewers_message,
    generating,
    latestThreadMessage,
    isLastMessageInThread,
  ]);

  const renderAcpState = () => {
    if (!acpStateToRender) return null;
    if (acpStateToRender === "queue") {
      return (
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <Tag color="gold">queued</Tag>
          <Button
            size="small"
            type="text"
            onClick={handleSendQueuedImmediately}
          >
            Send now
          </Button>
          <Button size="small" type="text" onClick={handleCancelQueued}>
            Cancel
          </Button>
        </span>
      );
    }
    if (acpStateToRender === "not-sent") {
      return (
        <Button size="small" type="text" disabled>
          not sent
        </Button>
      );
    }
    return (
      <Tag color="blue">
        {acpStateToRender === "sending" ||
        acpStateToRender === "sent" ||
        acpStateToRender === "running" ? (
          <SyncOutlined spin />
        ) : null}{" "}
        {acpStateToRender === "sending"
          ? "submitting to Codex"
          : acpStateToRender === "sent"
            ? "waiting for Codex"
            : acpStateToRender === "running" && is_viewers_message
              ? "Codex is starting"
              : acpStateToRender}
      </Tag>
    );
  };

  return (
    <Row
      style={getStyle()}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {renderCols()}
      {renderZenMessageDrawer()}
      <GitCommitDrawer
        projectId={project_id}
        sourcePath={path}
        cwdOverride={activityBasePath}
        commitHash={openCommitHash}
        open={openCommitHash != null}
        onClose={() => setOpenCommitHash(undefined)}
        fontSize={font_size}
        onRequestAgentTurn={sendGitBrowserAgentPrompt}
        onDirectCommitLogged={logGitBrowserDirectCommit}
        onFindInChat={findCommitInCurrentChat}
        onOpenActivityLog={openActivityFromGitBrowser}
      />
      {acpStateToRender ? (
        <div style={{ width: "100%" }}>
          <Divider>{renderAcpState()}</Divider>
        </div>
      ) : undefined}
    </Row>
  );
}

// Used for exporting chat to markdown file
export function message_to_markdown(
  message,
  options?: { includeLog?: boolean; includeHeader?: boolean },
): string {
  const includeLog = options?.includeLog ?? false;
  const includeHeader = options?.includeHeader ?? true;
  let value = newest_content(message);
  const user_map = redux.getStore("users").get("user_map");
  const sender = getUserName(
    user_map,
    field<string>(message, "sender_id") ?? "",
  );
  const date = dateValue(message)?.toString() ?? "";

  if (includeLog) {
    const logMarkdown = message_codex_log_to_markdown(message);
    if (logMarkdown) {
      value = `${value}\n\n**Log**\n\n${logMarkdown}`;
    }
  }
  if (!includeHeader) return value;
  return `*From:* ${sender}  \n*Date:* ${date}  \n\n${value}`;
}

function message_codex_log_to_markdown(message): string {
  const events = message?.get?.("acp_events");
  if (!events) return "";
  const list = typeof events.toJS === "function" ? events.toJS() : events;
  if (!Array.isArray(list) || list.length === 0) return "";
  try {
    return codexEventsToMarkdown(list);
  } catch (err) {
    console.warn("failed to render codex log to markdown", err);
    return "";
  }
}
