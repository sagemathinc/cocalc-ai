/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Alert, Button, Divider, Input, Radio, Space, Typography } from "antd";

import api from "@cocalc/frontend/client/api";
import { PublicSectionCard } from "@cocalc/frontend/public/ui/shell";
import { is_valid_email_address as isValidEmailAddress } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import RecentFiles from "./recent-files";

type SupportView = "index" | "new" | "tickets";
type TicketType = "problem" | "question" | "task" | "purchase" | "chat";

interface SupportConfig {
  help_email?: string;
  site_name?: string;
  support_video_call?: string;
  zendesk?: boolean;
}

interface QueryState {
  body: string;
  context: string;
  hideExtra: boolean;
  required: string;
  subject: string;
  title: string;
  type: TicketType;
  url: string;
}

interface SupportFileRef {
  path?: string;
  project_id: string;
}

const { Paragraph, Text, Title } = Typography;

const MIN_BODY_LENGTH = 16;

function stringToType(value?: string): TicketType {
  switch (value) {
    case "problem":
    case "question":
    case "task":
    case "purchase":
    case "chat":
      return value;
    default:
      return "problem";
  }
}

function useInitialQueryState(): QueryState {
  return useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      body: params.get("body") ?? "",
      context: params.get("context") ?? "",
      hideExtra: params.get("hideExtra") === "true",
      required: params.get("required") ?? "",
      subject: params.get("subject") ?? "",
      title: params.get("title") ?? "",
      type: stringToType(params.get("type") ?? undefined),
      url: params.get("url") ?? window.location.href,
    };
  }, []);
}

function Status({ done }: { done: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        borderRadius: "50%",
        background: done ? "#f6ffed" : "#fff7e6",
        border: `1px solid ${done ? "#b7eb8f" : "#ffd591"}`,
        color: done ? "#389e0d" : "#d46b08",
        fontSize: 12,
        fontWeight: 700,
        marginRight: 8,
      }}
    >
      {done ? "✓" : "→"}
    </span>
  );
}

function SectionLabel({
  children,
  done,
}: {
  children: ReactNode;
  done: boolean;
}) {
  return (
    <div style={{ fontSize: 16, fontWeight: 700 }}>
      <Status done={done} />
      {children}
    </div>
  );
}

function composeSections(sections: Array<[string, string]>): string {
  return sections
    .map(([heading, value]) =>
      value.trim().length > 0 ? `${heading}\n\n${value.trim()}` : "",
    )
    .filter(Boolean)
    .join("\n\n\n");
}

function ProblemFields({
  disabled,
  onChange,
}: {
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const answers = useRef<[string, string, string]>(["", "", ""]);

  function update(index: 0 | 1 | 2, value: string): void {
    answers.current[index] = value;
    onChange(
      composeSections([
        ["WHAT DID YOU DO EXACTLY?", answers.current[0]],
        ["WHAT HAPPENED?", answers.current[1]],
        ["HOW DID THIS DIFFER FROM WHAT YOU EXPECTED?", answers.current[2]],
      ]),
    );
  }

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <div>
        <Text strong>What did you do exactly?</Text>
        <Input.TextArea
          disabled={disabled}
          rows={3}
          placeholder="Describe exactly what you did before the problem happened."
          style={{ marginTop: 8 }}
          onChange={(e) => update(0, e.target.value)}
        />
      </div>
      <div>
        <Text strong>What happened?</Text>
        <Input.TextArea
          disabled={disabled}
          rows={3}
          placeholder="Tell us what happened."
          style={{ marginTop: 8 }}
          onChange={(e) => update(1, e.target.value)}
        />
      </div>
      <div>
        <Text strong>How did this differ from what you expected?</Text>
        <Input.TextArea
          disabled={disabled}
          rows={3}
          placeholder="Explain what you expected instead."
          style={{ marginTop: 8 }}
          onChange={(e) => update(2, e.target.value)}
        />
      </div>
    </Space>
  );
}

function QuestionFields({
  defaultValue,
  disabled,
  onChange,
}: {
  defaultValue: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Input.TextArea
      disabled={disabled}
      rows={8}
      defaultValue={defaultValue}
      placeholder="Ask your question here."
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function PurchaseFields({
  defaultValue,
  disabled,
  onChange,
  showExtra,
}: {
  defaultValue: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  showExtra: boolean;
}) {
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      {showExtra ? (
        <Alert
          showIcon
          type="info"
          title="What information helps us respond quickly?"
          description={
            <ul style={{ marginBottom: 0, paddingLeft: 18 }}>
              <li>The rough number of users or projects.</li>
              <li>The kind of workload you expect.</li>
              <li>How long you expect to use the service.</li>
              <li>Any academic, classroom, or organizational context.</li>
            </ul>
          }
        />
      ) : null}
      <Input.TextArea
        disabled={disabled}
        rows={8}
        defaultValue={defaultValue}
        placeholder="Describe what you want to purchase and any constraints we should know about."
        onChange={(e) => onChange(e.target.value)}
      />
    </Space>
  );
}

function TaskFields({
  disabled,
  onChange,
  siteName,
}: {
  disabled?: boolean;
  onChange: (value: string) => void;
  siteName: string;
}) {
  const answers = useRef<[string, string, string]>(["", "", ""]);

  function update(index: 0 | 1 | 2, value: string): void {
    answers.current[index] = value;
    onChange(
      composeSections([
        ["WHAT SOFTWARE DO YOU NEED?", answers.current[0]],
        ["HOW DO YOU PLAN TO USE THIS SOFTWARE?", answers.current[1]],
        [
          "HOW CAN WE TEST THAT THE SOFTWARE IS PROPERLY INSTALLED?",
          answers.current[2],
        ],
      ]),
    );
  }

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        showIcon
        type="info"
        title="Software install requests"
        description={
          <>
            {siteName} projects run Linux, so software requests are often
            possible. Please tell us exactly what you need and how to verify the
            install.
          </>
        }
      />
      <div>
        <Text strong>What software do you need?</Text>
        <Input.TextArea
          disabled={disabled}
          rows={4}
          placeholder="Name the software, package, library, or stack you need."
          style={{ marginTop: 8 }}
          onChange={(e) => update(0, e.target.value)}
        />
      </div>
      <div>
        <Text strong>How do you plan to use this software?</Text>
        <Input.TextArea
          disabled={disabled}
          rows={3}
          placeholder="Explain the workload, project, class, or timeline."
          style={{ marginTop: 8 }}
          onChange={(e) => update(1, e.target.value)}
        />
      </div>
      <div>
        <Text strong>
          How can we test that the software is properly installed?
        </Text>
        <Input.TextArea
          disabled={disabled}
          rows={3}
          placeholder="Include the commands, notebook imports, or checks that should work."
          style={{ marginTop: 8 }}
          onChange={(e) => update(2, e.target.value)}
        />
      </div>
    </Space>
  );
}

function bodyButtonLabel(params: {
  body: string;
  email: string;
  hasRequired: boolean;
  subject: string;
  submitting: boolean;
  successUrl: string;
  submitError: string;
  type: TicketType;
}): string {
  const {
    body,
    email,
    hasRequired,
    subject,
    submitting,
    successUrl,
    submitError,
    type,
  } = params;

  if (submitting) {
    return "Submitting...";
  }
  if (successUrl) {
    return "Ticket created";
  }
  if (submitError) {
    return "Fix the error above to try again";
  }
  if (!isValidEmailAddress(email)) {
    return "Enter a valid email address";
  }
  if (!subject.trim()) {
    return "Enter a subject";
  }
  if ((body ?? "").trim().length < MIN_BODY_LENGTH) {
    return type === "chat"
      ? "Describe the video chat you want"
      : `Describe your ${type} in more detail`;
  }
  if (!hasRequired) {
    return "Replace the required placeholder text";
  }
  return "Create support ticket";
}

function renderBodyFields(params: {
  body: string;
  disabled?: boolean;
  setBody: (value: string) => void;
  showExtra: boolean;
  siteName: string;
  supportVideoCall?: string;
  type: TicketType;
}) {
  const { body, setBody, showExtra, siteName, supportVideoCall, type } = params;
  const { disabled } = params;

  if (type === "problem") {
    return <ProblemFields disabled={disabled} onChange={setBody} />;
  }
  if (type === "question") {
    return (
      <QuestionFields
        defaultValue={body}
        disabled={disabled}
        onChange={setBody}
      />
    );
  }
  if (type === "purchase") {
    return (
      <PurchaseFields
        defaultValue={body}
        disabled={disabled}
        onChange={setBody}
        showExtra={showExtra}
      />
    );
  }
  if (type === "task") {
    return (
      <TaskFields disabled={disabled} onChange={setBody} siteName={siteName} />
    );
  }
  return (
    <Alert
      showIcon
      type="info"
      title={
        supportVideoCall ? (
          <>
            You can also <a href={supportVideoCall}>book a video call</a>.
          </>
        ) : (
          "Video chat request"
        )
      }
      description={
        <Input.TextArea
          disabled={disabled}
          rows={6}
          defaultValue={body}
          placeholder="Describe what you want to discuss, your goals, and any scheduling constraints."
          style={{ marginTop: 12 }}
          onChange={(e) => setBody(e.target.value)}
        />
      }
    />
  );
}

export default function SupportNew({
  config,
  onNavigate,
}: {
  config: SupportConfig;
  onNavigate: (view: SupportView) => void;
}) {
  const initial = useInitialQueryState();
  const siteName = config.site_name ?? "CoCalc";
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState(initial.subject);
  const [type, setType] = useState<TicketType>(initial.type);
  const [body, setBody] = useState(initial.body);
  const [files, setFiles] = useState<SupportFileRef[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [successUrl, setSuccessUrl] = useState("");
  const feedbackRef = useRef<HTMLDivElement | null>(null);
  const formLocked = !!successUrl;

  const hasRequired = !initial.required || !body.includes(initial.required);
  const canSubmit =
    !submitting &&
    !submitError &&
    !successUrl &&
    isValidEmailAddress(email) &&
    subject.trim().length > 0 &&
    body.trim().length >= MIN_BODY_LENGTH &&
    hasRequired;

  async function submit() {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    setSuccessUrl("");
    try {
      const info: Record<string, string> = {
        context: "public-support",
        userAgent: navigator.userAgent,
      };
      if (initial.context) {
        info.context = initial.context;
      }
      const result = await api("support/create-ticket", {
        options: {
          email,
          subject,
          body,
          files,
          type,
          url: initial.url,
          info,
        },
      });
      if (result?.url) {
        setSuccessUrl(result.url);
      } else if (result?.error) {
        setSubmitError(result.error);
      }
    } catch (err) {
      setSubmitError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (!submitError && !successUrl) {
      return;
    }
    if (typeof feedbackRef.current?.scrollIntoView !== "function") {
      return;
    }
    feedbackRef.current.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [submitError, successUrl]);

  useEffect(() => {
    let canceled = false;
    if (email.trim().length > 0) {
      return;
    }
    (async () => {
      try {
        const result = await api("accounts/profile");
        const nextEmail = result?.profile?.email_address;
        if (
          !canceled &&
          typeof nextEmail === "string" &&
          nextEmail.length > 0
        ) {
          setEmail(nextEmail);
        }
      } catch {
        // Anonymous sessions are expected to land here.
      }
    })();
    return () => {
      canceled = true;
    };
  }, [email]);

  if (!config.zendesk) {
    return (
      <Alert
        showIcon
        type="error"
        title="Support ticket creation is not configured."
      />
    );
  }

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      {!initial.hideExtra ? (
        <PublicSectionCard>
          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            <Title level={2} style={{ margin: 0 }}>
              {initial.title || "Create a New Support Ticket"}
            </Title>
            <Paragraph style={{ fontSize: 16, marginBottom: 0 }}>
              Create a new support ticket below or{" "}
              <a
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate("tickets");
                }}
              >
                check the status of your support tickets
              </a>
              .
            </Paragraph>
            {config.help_email ? (
              <Paragraph style={{ fontSize: 16, marginBottom: 0 }}>
                You can also email us directly at{" "}
                <a href={`mailto:${config.help_email}`}>{config.help_email}</a>.
              </Paragraph>
            ) : null}
            {config.support_video_call ? (
              <Paragraph style={{ fontSize: 16, marginBottom: 0 }}>
                Alternatively, you can{" "}
                <a href={config.support_video_call}>book a video call</a>.
              </Paragraph>
            ) : null}
            <Alert
              showIcon
              type="warning"
              title="Helpful links"
              description={
                <ul style={{ marginBottom: 0, paddingLeft: 18 }}>
                  <li>
                    <a href="https://doc.cocalc.com/">The CoCalc Manual</a>
                  </li>
                  <li>
                    <a href="https://github.com/sagemathinc/cocalc-ai/issues">
                      Bug reports
                    </a>
                  </li>
                </ul>
              }
            />
          </Space>
        </PublicSectionCard>
      ) : null}

      <PublicSectionCard>
        <Space orientation="vertical" size="large" style={{ width: "100%" }}>
          <div>
            <SectionLabel done={isValidEmailAddress(email)}>
              Your email address
            </SectionLabel>
            <Input
              disabled={formLocked}
              placeholder="Email address..."
              style={{ marginTop: 10, maxWidth: 520 }}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div>
            <SectionLabel done={subject.trim().length > 0}>
              Subject
            </SectionLabel>
            <Input
              disabled={formLocked}
              placeholder="Summarize what this is about..."
              style={{ marginTop: 10 }}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          <div>
            <SectionLabel done={body.trim().length >= MIN_BODY_LENGTH}>
              Support request type
            </SectionLabel>
            <Radio.Group
              disabled={formLocked}
              name="support-type"
              style={{ display: "block", marginTop: 10 }}
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setBody("");
              }}
            >
              <Space orientation="vertical" size="middle">
                <Radio value="problem">
                  Something is not working the way I think it should.
                </Radio>
                <Radio value="question">
                  I have a question about billing, functionality, teaching, or
                  how something works.
                </Radio>
                <Radio value="task">
                  I need help installing or configuring software.
                </Radio>
                <Radio value="purchase">
                  I have a question about pricing or purchasing.
                </Radio>
                <Radio value="chat">
                  I would like to schedule a video chat.
                </Radio>
              </Space>
            </Radio.Group>
          </div>

          <Divider style={{ margin: 0 }}>Support Ticket</Divider>

          {!initial.hideExtra && type !== "purchase" && type !== "chat" ? (
            <div>
              <SectionLabel done={files.length > 0}>
                Relevant files
              </SectionLabel>
              <Paragraph
                style={{ color: COLORS.GRAY_D, margin: "10px 0 12px 0" }}
              >
                Select any relevant projects and files below. This will make it
                much easier for us to quickly understand your problem.
              </Paragraph>
              <RecentFiles
                disabled={formLocked}
                interval="1 day"
                onChange={setFiles}
              />
            </div>
          ) : null}

          <div>
            <SectionLabel
              done={body.trim().length >= MIN_BODY_LENGTH && hasRequired}
            >
              Description
            </SectionLabel>
            <div
              style={{
                marginTop: 12,
                paddingLeft: 16,
                borderLeft: `2px solid ${COLORS.GRAY_LL}`,
              }}
            >
              {renderBodyFields({
                body,
                disabled: formLocked,
                setBody,
                showExtra: !initial.hideExtra,
                siteName,
                supportVideoCall: config.support_video_call,
                type,
              })}
            </div>
          </div>

          {!hasRequired ? (
            <Alert
              showIcon
              type="error"
              title="Required information is still missing"
              description={`Replace the text '${initial.required}' everywhere above with the requested information.`}
            />
          ) : null}

          <div style={{ textAlign: "center" }}>
            {formLocked ? (
              <Space wrap>
                <Button
                  shape="round"
                  size="large"
                  type="primary"
                  onClick={() => onNavigate("tickets")}
                >
                  View my tickets
                </Button>
                <Button
                  href={successUrl}
                  shape="round"
                  size="large"
                  target="_blank"
                >
                  Open saved ticket URL
                </Button>
              </Space>
            ) : (
              <Button
                disabled={!canSubmit}
                loading={submitting}
                shape="round"
                size="large"
                type="primary"
                onClick={submit}
              >
                {bodyButtonLabel({
                  body,
                  email,
                  hasRequired,
                  subject,
                  submitting,
                  successUrl,
                  submitError,
                  type,
                })}
              </Button>
            )}
          </div>

          <div ref={feedbackRef}>
            {submitError ? (
              <Alert
                closable
                showIcon
                type="error"
                title="Error creating support ticket"
                description={submitError}
                onClose={() => setSubmitError("")}
              />
            ) : null}

            {successUrl ? (
              <Alert
                closable
                showIcon
                type="success"
                title="Successfully created support ticket"
                description={
                  <Space orientation="vertical" size="small">
                    <div>
                      Please save this URL:{" "}
                      <a href={successUrl}>{successUrl}</a>
                    </div>
                    <div>
                      You can also{" "}
                      <a
                        onClick={(e) => {
                          e.preventDefault();
                          onNavigate("tickets");
                        }}
                      >
                        check the status of your support tickets
                      </a>
                      .
                    </div>
                  </Space>
                }
              />
            ) : null}
          </div>
        </Space>
      </PublicSectionCard>

      {type !== "chat" ? (
        <Paragraph style={{ color: COLORS.GRAY_D, marginBottom: 0 }}>
          After submitting this, you will receive a link that you should save
          until you receive a confirmation email. You can also review your
          support tickets later from the support page.
        </Paragraph>
      ) : null}
    </Space>
  );
}
