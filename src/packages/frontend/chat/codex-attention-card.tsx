/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { SafetyCertificateOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Radio, Space, Tag, Typography } from "antd";
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
import { COLORS } from "@cocalc/util/theme";
import { isValidUUID } from "@cocalc/util/misc";
import { appendUrlPath } from "@cocalc/util/url-path";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getControlPlaneAppUrl } from "@cocalc/frontend/control-plane-origin";
import { open_new_tab } from "@cocalc/frontend/misc/open-browser-tab";
import { showCodexNotificationBestEffort } from "@cocalc/frontend/notifications/codex-turn-toast";
import { lite } from "@cocalc/frontend/lite";

const { Paragraph, Text, Title } = Typography;
const POLL_MS = 2_000;

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
      return "Codex disconnected";
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

export function CodexAttentionCard({
  initialRecord,
}: {
  initialRecord: AcpAttentionRecord;
}) {
  const [record, setRecord] = useState(initialRecord);
  const [selected, setSelected] = useState<Record<string, string | undefined>>(
    {},
  );
  const [other, setOther] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const responseIdRef = useRef(responseId());
  const markedSeenRef = useRef(initialRecord.seen_at != null);

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
        if (result.ok && result.record) setRecord(result.record);
      })
      .catch(() => {
        // Seeing the request must not be blocked by a transient delivery error.
        markedSeenRef.current = false;
      });
  }, [initialRecord.attention_id, initialRecord.project_id]);

  useEffect(() => {
    void showCodexNotificationBestEffort({
      account_id: record.account_id,
      row: {
        notification_id: record.attention_id,
        kind: "account_notice",
        project_id: record.project_id,
        summary: {
          notice_type: "codex_attention",
          origin_label: "Codex",
          attention_id: record.attention_id,
          attention_state: record.state,
          message_date: record.message_date,
          path: record.path,
          thread_id: record.thread_id,
          stable_source_id: record.source_id,
        },
      },
    });
  }, [record]);

  useEffect(() => {
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
          if (next) setRecord(next);
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
            selected: selected[question.id],
            other: other[question.id] ?? "",
          }),
        ]),
      ),
    [other, record.questions, selected],
  );
  const canSubmit = record.questions.every(
    ({ id }) => (answers[id]?.length ?? 0) > 0,
  );

  const respond = async (decline = false) => {
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await webapp_client.conat_client.attentionAcp({
        action: "respond",
        project_id: record.project_id,
        attention_id: record.attention_id,
        response_id: responseIdRef.current,
        answers: decline ? undefined : answers,
        decline,
      });
      if (!result.ok || !result.record) {
        throw new Error(result.error ?? "The response was not accepted.");
      }
      setRecord(result.record);
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
  const pendingFreshAuth =
    pending &&
    record.source_kind === "cocalc_action" &&
    record.action?.kind === "fresh_auth";
  const staleWithAnswer =
    record.state === "stale" && record.response_submitted_at != null;
  const responseAwaitingCodex =
    pending && record.response_submitted_at != null && !pendingFreshAuth;
  return (
    <section
      aria-label="Codex needs attention"
      data-codex-attention-id={record.attention_id}
      tabIndex={-1}
      style={{
        border: `1px solid ${pending ? COLORS.YELL_D : COLORS.GRAY_L}`,
        borderRadius: 8,
        padding: 12,
        width: "100%",
        background: pending ? COLORS.YELL_LLL : undefined,
      }}
    >
      <Space orientation="vertical" size={10} style={{ width: "100%" }}>
        <Space wrap style={{ justifyContent: "space-between", width: "100%" }}>
          <Title level={5} style={{ margin: 0 }}>
            {record.title}
          </Title>
          <Tag
            color={
              pending ? "gold" : record.state === "stale" ? "red" : "default"
            }
          >
            {pendingFreshAuth
              ? "Waiting for authorization"
              : responseAwaitingCodex
                ? "Response submitted"
                : stateLabel(record.state)}
          </Tag>
        </Space>
        <Text type="secondary" aria-live="polite">
          {pendingFreshAuth
            ? "Approve this request in CoCalc. The waiting command will continue automatically."
            : responseAwaitingCodex
              ? "Your response is saved. Waiting for Codex to accept it."
              : record.is_blocking
                ? "The current Codex turn is paused until you respond."
                : record.source_kind === "codex_async_question"
                  ? "Codex may continue while it waits. Your response starts a new user message."
                  : record.summary}
        </Text>
        {lite && pending ? (
          <Text type="secondary">
            This request is available in this project. Cross-device inbox and
            email delivery are not available in CoCalc Lite.
          </Text>
        ) : null}
        {pending && !pendingFreshAuth && !responseAwaitingCodex
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
                    value={selected[question.id]}
                    onChange={(event) => {
                      setSelected((current) => ({
                        ...current,
                        [question.id]: String(event.target.value),
                      }));
                      setOther((current) => ({
                        ...current,
                        [question.id]: "",
                      }));
                    }}
                    style={{ display: "grid", gap: 6, marginBottom: 8 }}
                  >
                    {question.options.map((option) => (
                      <Radio key={option.label} value={option.label}>
                        <Space orientation="vertical" size={0}>
                          <span>{option.label}</span>
                          {option.description ? (
                            <Text type="secondary">{option.description}</Text>
                          ) : null}
                        </Space>
                      </Radio>
                    ))}
                  </Radio.Group>
                ) : null}
                {question.isOther || !question.options?.length ? (
                  <Input.TextArea
                    aria-label={`Custom answer for ${question.header}`}
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    placeholder="Type an answer"
                    value={other[question.id] ?? ""}
                    onChange={(event) => {
                      setOther((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }));
                      if (event.target.value) {
                        setSelected((current) => ({
                          ...current,
                          [question.id]: undefined,
                        }));
                      }
                    }}
                  />
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
        ) : pending && !responseAwaitingCodex ? (
          <Space wrap>
            <Button
              type="primary"
              disabled={!canSubmit}
              loading={submitting}
              onClick={() => void respond(false)}
            >
              Send response
            </Button>
            <Button disabled={submitting} onClick={() => void respond(true)}>
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
      </Space>
    </section>
  );
}
