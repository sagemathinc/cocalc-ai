/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { SafetyCertificateOutlined } from "@ant-design/icons";
import { Alert, Button, Radio, Space, Tag, Typography } from "antd";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import type {
  AcpAttentionQuestion,
  AcpAttentionRecord,
} from "@cocalc/conat/ai/acp/types";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  CODEX_ATTENTION_ANSWER_MAX_LENGTH,
  codexAttentionAcceptingRuntime,
} from "@cocalc/util/ai/codex-attention";
import { isValidUUID } from "@cocalc/util/misc";
import { appendUrlPath } from "@cocalc/util/url-path";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getControlPlaneAppUrl } from "@cocalc/frontend/control-plane-origin";
import { open_new_tab } from "@cocalc/frontend/misc/open-browser-tab";
import { lite } from "@cocalc/frontend/lite";
import { useNamedAgents } from "@cocalc/frontend/agents/api";
import { findWorkspaceAgentForThread } from "@cocalc/frontend/agents/workspace-model";

const { Paragraph, Text, Title } = Typography;
const POLL_MS = 2_000;
const RESPONSE_PREVIEW_LENGTH = 400;

function SubmittedAnswer({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  if (value.length <= RESPONSE_PREVIEW_LENGTH) {
    return <div style={{ whiteSpace: "pre-wrap" }}>{value}</div>;
  }
  return (
    <div>
      <div style={{ whiteSpace: "pre-wrap" }}>
        {expanded ? value : `${value.slice(0, RESPONSE_PREVIEW_LENGTH)}...`}
      </div>
      <Button
        size="small"
        type="link"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "Hide full response" : "Show full response"}
      </Button>
    </div>
  );
}

function responseId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `attention-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function stateLabel(state: AcpAttentionRecord["state"]): string {
  switch (state) {
    case "pending":
      return "Waiting for your response";
    case "answered":
      return "Answered";
    case "declined":
      return "Declined";
    case "stale":
      return "Request no longer active";
    case "canceled":
      return "Canceled";
    case "expired":
      return "Expired";
    case "superseded":
      return "Superseded";
    default:
      return "Resolved";
  }
}

export function codexFreshAuthUrl(
  reference: string,
  baseUrl = getControlPlaneAppUrl() ?? appBasePath,
): string | undefined {
  if (!isValidUUID(reference)) return;
  return appendUrlPath(baseUrl, "auth", "cli-elevate", reference);
}

function answersForQuestion(opts: {
  question: AcpAttentionQuestion;
  selected?: string;
  other: string;
}): string[] {
  const answer = opts.other.trim();
  return answer ? [answer] : opts.selected ? [opts.selected] : [];
}

export interface CodexAttentionDraft {
  selected: Record<string, string | undefined>;
  other: Record<string, string>;
  submitted?: {
    answers: Record<string, string[]>;
    declined: boolean;
  };
}

export type CodexAttentionDraftUpdater = (
  current: CodexAttentionDraft,
) => CodexAttentionDraft;

export function CodexAttentionCard({
  initialRecord,
  responseInActivity,
  draft: savedDraft,
  onDraftChange,
}: {
  initialRecord: AcpAttentionRecord;
  responseInActivity?: boolean;
  draft?: CodexAttentionDraft;
  onDraftChange?: (update: CodexAttentionDraftUpdater) => void;
}) {
  return (
    <RuntimeCodexAttentionCard
      key={`${initialRecord.account_id}:${initialRecord.attention_id}`}
      initialRecord={initialRecord}
      responseInActivity={responseInActivity}
      draft={savedDraft}
      onDraftChange={onDraftChange}
    />
  );
}

function RuntimeCodexAttentionCard({
  initialRecord,
  responseInActivity,
  draft: savedDraft,
  onDraftChange,
}: {
  initialRecord: AcpAttentionRecord;
  responseInActivity?: boolean;
  draft?: CodexAttentionDraft;
  onDraftChange?: (update: CodexAttentionDraftUpdater) => void;
}) {
  const [record, setRecord] = useState(initialRecord);
  // Questions come from any agent runtime (Codex, Claude, ...): name the agent
  // by the @alias the user gave it, not by one runtime.
  const { directory } = useNamedAgents(!lite);
  const namedAgent = findWorkspaceAgentForThread(
    directory?.agents ?? [],
    record.project_id,
    record.path,
    record.thread_id,
  );
  const agentName = namedAgent ? `@${namedAgent.name}` : undefined;
  const [localDraft, setLocalDraft] = useState<CodexAttentionDraft>({
    selected: {},
    other: {},
  });
  const draft = savedDraft ?? localDraft;
  const updateDraft = onDraftChange ?? setLocalDraft;
  const [submitting, setSubmitting] = useState(false);
  const [uploads, setUploads] = useState(0);
  const [error, setError] = useState<string>();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = sessionStorage.getItem(
        `codex-attention-collapsed:${initialRecord.attention_id}`,
      );
      return (
        stored === "1" ||
        (stored == null &&
          ["answered", "declined"].includes(initialRecord.state))
      );
    } catch {
      return false;
    }
  });
  const responseIdRef = useRef(responseId());
  const markedSeenRef = useRef(initialRecord.seen_at != null);
  const receiptRef = useRef<HTMLDivElement>(null);
  const restoreReceiptFocus = useRef(false);

  const acceptRecord = (next: AcpAttentionRecord) => {
    setRecord((current) =>
      next.updated_at > current.updated_at ? next : current,
    );
  };

  useEffect(() => {
    if (restoreReceiptFocus.current && draft.submitted) {
      restoreReceiptFocus.current = false;
      receiptRef.current?.focus();
    }
  }, [draft.submitted]);

  useEffect(() => {
    setRecord((current) =>
      initialRecord.updated_at > current.updated_at ? initialRecord : current,
    );
  }, [initialRecord]);

  useEffect(() => {
    if (markedSeenRef.current) return;
    markedSeenRef.current = true;
    void webapp_client.conat_client
      .attentionAcp({
        action: "seen",
        project_id: initialRecord.project_id,
        attention_id: initialRecord.attention_id,
      })
      .then((result) => {
        if (result.ok && result.record) acceptRecord(result.record);
      })
      .catch(() => {
        // Seeing the request must not be blocked by a transient delivery error.
        markedSeenRef.current = false;
      });
  }, [initialRecord.attention_id, initialRecord.project_id]);

  useEffect(() => {
    if (record.state !== "pending") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await webapp_client.conat_client.attentionAcp({
          action: "list",
          project_id: initialRecord.project_id,
          path: initialRecord.path,
          thread_id: initialRecord.thread_id,
          state: "all",
        });
        if (!disposed) {
          const next = result.records?.find(
            ({ attention_id }) => attention_id === initialRecord.attention_id,
          );
          if (result.ok && next) acceptRecord(next);
        }
      } catch (err) {
        if (!disposed && record.state === "pending") {
          setError(`Unable to refresh this request: ${err}`);
        }
      } finally {
        if (!disposed && record.state === "pending") {
          timer = setTimeout(() => void refresh(), POLL_MS);
        }
      }
    };
    void refresh();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    initialRecord.attention_id,
    initialRecord.path,
    initialRecord.project_id,
    initialRecord.thread_id,
    record.state,
  ]);

  const answers = useMemo(
    () =>
      Object.fromEntries(
        record.questions.map((question) => [
          question.id,
          answersForQuestion({
            question,
            selected: draft.selected[question.id],
            other: draft.other[question.id] ?? "",
          }),
        ]),
      ),
    [draft, record.questions],
  );
  const canSubmit = record.questions.every(
    ({ id }) =>
      (answers[id]?.length ?? 0) > 0 &&
      answers[id].every(
        (answer) => answer.length <= CODEX_ATTENTION_ANSWER_MAX_LENGTH,
      ),
  );

  const respond = async (decline = false) => {
    setSubmitting(true);
    setError(undefined);
    const focusedControl = document.activeElement;
    try {
      const result = await webapp_client.conat_client.attentionAcp({
        action: "respond",
        project_id: record.project_id,
        attention_id: record.attention_id,
        response_id: responseIdRef.current,
        answers: decline ? undefined : answers,
        decline,
      });
      if (result.state === "already_submitted") {
        if (result.record) setRecord(result.record);
        throw new Error(
          "This question already has a response. Your draft was not submitted.",
        );
      }
      // A dispatch failure can still include a durably saved response.
      if (
        result.record &&
        (result.ok || result.record.response_submitted_at != null)
      ) {
        restoreReceiptFocus.current = document.activeElement === focusedControl;
        updateDraft((current) => ({
          ...current,
          submitted: { answers: decline ? {} : answers, declined: decline },
        }));
        setRecord(result.record);
      }
      if (!result.ok || !result.record) {
        throw new Error(result.error ?? "The response was not accepted.");
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  };

  const updateDelivery = async (action: "acknowledge" | "snooze") => {
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await webapp_client.conat_client.attentionAcp({
        action,
        project_id: record.project_id,
        attention_id: record.attention_id,
        ...(action === "snooze"
          ? { snoozed_until: Date.now() + 5 * 60_000 }
          : {}),
      });
      if (!result.ok || !result.record) {
        throw new Error(result.error ?? "The request could not be updated.");
      }
      setRecord(result.record);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  };

  const continueAnswer = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await webapp_client.conat_client.attentionAcp({
        action: "continue",
        project_id: record.project_id,
        attention_id: record.attention_id,
      });
      if (!result.ok || !result.record) {
        throw new Error(result.error ?? "The answer could not be continued.");
      }
      setRecord(result.record);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  };

  const openFreshAuth = async () => {
    const action = record.action;
    const url =
      action?.kind === "fresh_auth"
        ? codexFreshAuthUrl(action.reference)
        : undefined;
    if (!url) {
      setError("This authorization request is invalid.");
      return;
    }
    open_new_tab(url);
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await webapp_client.conat_client.attentionAcp({
        action: "execute_action",
        project_id: record.project_id,
        attention_id: record.attention_id,
      });
      if (!result.ok || !result.record) {
        throw new Error(
          result.error ?? "The authorization could not be checked.",
        );
      }
      setRecord(result.record);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  };

  const pending = record.state === "pending";
  const lateQuestion =
    record.state === "stale" && record.source_kind === "codex_sync_question";
  const submitted = draft.submitted;
  const hasResponse = record.response_submitted_at != null || submitted != null;
  const answerable = (pending || lateQuestion) && !hasResponse;
  const pendingFreshAuth =
    pending &&
    record.source_kind === "cocalc_action" &&
    record.action?.kind === "fresh_auth";
  const staleWithAnswer = record.state === "stale" && hasResponse;
  // An async "answered" record can mean merely queued, not model receipt.
  const acceptingRuntime =
    record.source_kind === "codex_sync_question" && record.state === "answered"
      ? codexAttentionAcceptingRuntime(record.resolution_reason)
      : undefined;
  const received = acceptingRuntime != null;
  const responseAgent =
    acceptingRuntime === "Codex"
      ? "Codex"
      : (agentName ?? (acceptingRuntime === "Claude" ? "Claude" : "The agent"));
  const responseLabel = received
    ? `Received by ${responseAgent === "The agent" ? "agent" : responseAgent}`
    : staleWithAnswer
      ? "Response saved; delivery failed"
      : "Response submitted";
  const responseDescription = received
    ? `${responseAgent} accepted your response.`
    : staleWithAnswer
      ? "Your response is saved, but could not be delivered. You can retry with this answer."
      : "Your response is saved. Receipt by the agent is not confirmed.";
  const setDismissed = (value: boolean) => {
    setCollapsed(value);
    try {
      const key = `codex-attention-collapsed:${record.attention_id}`;
      if (value) sessionStorage.setItem(key, "1");
      else sessionStorage.removeItem(key);
    } catch {
      // Session storage may be unavailable in a restricted browser context.
    }
  };
  return (
    <section
      aria-label={`${agentName ?? "The agent"} needs attention`}
      data-codex-attention-id={record.attention_id}
      tabIndex={-1}
      style={{
        border: `1px solid ${UI_COLORS.border}`,
        borderLeft: `3px solid ${pending ? UI_COLORS.warning : UI_COLORS.secondary}`,
        borderRadius: 12,
        padding: "12px 16px",
        width: "100%",
        minWidth: 0,
        overflowWrap: "anywhere",
        color: UI_COLORS.text,
        background: UI_COLORS.surface,
      }}
    >
      <Space orientation="vertical" size={10} style={{ width: "100%" }}>
        <Space wrap style={{ justifyContent: "space-between", width: "100%" }}>
          <Space wrap>
            <Title level={5} style={{ margin: 0 }}>
              {record.title}
            </Title>
            <Tag color={pending ? "gold" : "default"}>
              {pendingFreshAuth
                ? "Waiting for authorization"
                : hasResponse
                  ? responseLabel
                  : lateQuestion
                    ? "Turn ended"
                    : stateLabel(record.state)}
            </Tag>
          </Space>
          <Button
            type="text"
            aria-expanded={!collapsed}
            onClick={() => setDismissed(!collapsed)}
          >
            {collapsed ? "Show question" : "Dismiss"}
          </Button>
        </Space>
        <div
          ref={receiptRef}
          tabIndex={-1}
          role={hasResponse ? "status" : undefined}
          aria-live="polite"
          aria-atomic="true"
        >
          {hasResponse ? responseDescription : null}
        </div>
        {!collapsed && (
          <>
            {!hasResponse && (
              <Text type="secondary" aria-live="polite">
                {pendingFreshAuth
                  ? "Approve this request in CoCalc. The waiting command will continue automatically."
                  : lateQuestion
                    ? "That turn has ended. Send your answer as a new message to continue."
                    : !pending
                      ? record.resolution_reason
                      : record.is_blocking
                        ? (record.summary ??
                          "The current turn is paused until you respond.")
                        : record.source_kind === "codex_async_question"
                          ? `${agentName ?? "The agent"} can keep working while you answer. Your response will be saved with this question and submitted to ${agentName ?? "the agent"}.`
                          : record.summary}
              </Text>
            )}
            {lite && pending ? (
              <Text type="secondary">
                This request is available in this project. Cross-device inbox
                and email delivery are not available in CoCalc Lite.
              </Text>
            ) : null}
            {hasResponse && responseInActivity ? (
              <Text type="secondary">
                Your question and saved answer are in the turn activity.
              </Text>
            ) : null}
            {hasResponse && !responseInActivity
              ? record.questions.map((question) => (
                  <section
                    key={question.id}
                    aria-label={`Response for ${question.header}`}
                  >
                    <Text strong>{question.header}</Text>
                    <Paragraph
                      style={{ margin: "4px 0 8px", whiteSpace: "pre-wrap" }}
                    >
                      {question.question}
                    </Paragraph>
                    <Text strong>Your response</Text>
                    <SubmittedAnswer
                      value={
                        submitted?.declined
                          ? "Declined to answer"
                          : (submitted?.answers[question.id]?.join("\n") ??
                            "Response saved. Answer text is not available in this view.")
                      }
                    />
                  </section>
                ))
              : null}
            {answerable && !pendingFreshAuth
              ? record.questions.map((question) => (
                  <fieldset
                    key={question.id}
                    style={{
                      border: 0,
                      margin: 0,
                      minWidth: 0,
                      padding: 0,
                    }}
                  >
                    <legend style={{ fontWeight: 600, padding: 0 }}>
                      {question.header}
                    </legend>
                    <Paragraph
                      style={{ margin: "4px 0 8px", whiteSpace: "pre-wrap" }}
                    >
                      {question.question}
                    </Paragraph>
                    {question.options?.length ? (
                      <Radio.Group
                        aria-label={`Suggested answers for ${question.header}`}
                        name={`codex-attention-${record.attention_id}-${question.id}`}
                        value={draft.selected[question.id]}
                        onChange={(event) => {
                          updateDraft((current) => ({
                            selected: {
                              ...current.selected,
                              [question.id]: String(event.target.value),
                            },
                            other: { ...current.other, [question.id]: "" },
                          }));
                        }}
                        style={{ display: "grid", gap: 6, marginBottom: 8 }}
                      >
                        {question.options.map((option) => (
                          <Radio key={option.label} value={option.label}>
                            <Space orientation="vertical" size={0}>
                              <span>{option.label}</span>
                              {option.description ? (
                                <Text type="secondary">
                                  {option.description}
                                </Text>
                              ) : null}
                            </Space>
                          </Radio>
                        ))}
                      </Radio.Group>
                    ) : null}
                    {question.isOther || !question.options?.length ? (
                      <div
                        role="group"
                        aria-label={`Custom answer for ${question.header}`}
                      >
                        <MarkdownInput
                          cacheId={`codex-answer:${record.attention_id}:${question.id}`}
                          project_id={record.project_id}
                          path={record.path}
                          placeholder={`Custom answer for ${question.header}`}
                          autoGrow
                          autoGrowMaxHeight={220}
                          hideHelp
                          compact
                          enableMentions={false}
                          enableUpload
                          saveDebounceMs={0}
                          undoMode="local"
                          redoMode="local"
                          onUploadStart={() => setUploads((n) => n + 1)}
                          onUploadEnd={() =>
                            setUploads((n) => Math.max(0, n - 1))
                          }
                          value={draft.other[question.id] ?? ""}
                          onChange={(value) => {
                            updateDraft((current) => ({
                              other: { ...current.other, [question.id]: value },
                              selected: value
                                ? {
                                    ...current.selected,
                                    [question.id]: undefined,
                                  }
                                : current.selected,
                            }));
                          }}
                        />
                        <div role="status" aria-live="polite">
                          <Text
                            type={
                              (draft.other[question.id] ?? "").trim().length >
                              CODEX_ATTENTION_ANSWER_MAX_LENGTH
                                ? "danger"
                                : "secondary"
                            }
                          >
                            {(draft.other[question.id] ?? "").trim().length} /{" "}
                            {CODEX_ATTENTION_ANSWER_MAX_LENGTH} characters
                            {(draft.other[question.id] ?? "").trim().length >
                            CODEX_ATTENTION_ANSWER_MAX_LENGTH
                              ? ` (${(draft.other[question.id] ?? "").trim().length - CODEX_ATTENTION_ANSWER_MAX_LENGTH} over the limit)`
                              : ""}
                          </Text>
                        </div>
                      </div>
                    ) : null}
                  </fieldset>
                ))
              : null}
            {error ? (
              <Alert type="error" showIcon message={error} role="alert" />
            ) : null}
            {pendingFreshAuth ? (
              <Space wrap>
                <Button
                  type="primary"
                  icon={<SafetyCertificateOutlined />}
                  aria-label="Approve in CoCalc"
                  loading={submitting}
                  onClick={() => void openFreshAuth()}
                >
                  Approve in CoCalc
                </Button>
                <Button
                  disabled={submitting || record.acknowledged_at != null}
                  onClick={() => void updateDelivery("acknowledge")}
                >
                  Acknowledge
                </Button>
                <Button
                  disabled={submitting}
                  onClick={() => void updateDelivery("snooze")}
                >
                  Snooze 5 minutes
                </Button>
              </Space>
            ) : answerable ? (
              <Space wrap>
                <Button
                  type="primary"
                  disabled={!canSubmit || uploads > 0}
                  loading={submitting}
                  onClick={() => void respond(false)}
                >
                  {lateQuestion ? "Send as new message" : "Send response"}
                </Button>
                <Button
                  disabled={submitting}
                  onClick={() => void respond(true)}
                >
                  Decline
                </Button>
                <Button
                  disabled={submitting || record.acknowledged_at != null}
                  onClick={() => void updateDelivery("acknowledge")}
                >
                  Acknowledge
                </Button>
                <Button
                  disabled={submitting}
                  onClick={() => void updateDelivery("snooze")}
                >
                  Snooze 5 minutes
                </Button>
              </Space>
            ) : staleWithAnswer ? (
              <Button
                type="primary"
                loading={submitting}
                onClick={() => void continueAnswer()}
              >
                Continue with this answer
              </Button>
            ) : null}
          </>
        )}
      </Space>
    </section>
  );
}
