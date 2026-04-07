/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Input,
  Radio,
  Space,
  Typography,
} from "antd";
import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { uploadBlobImage } from "@cocalc/frontend/blobs/upload-image";
import ChatInput from "@cocalc/frontend/chat/input";
import { ThreadImageUpload } from "@cocalc/frontend/chat/thread-image-upload";
import api from "@cocalc/frontend/client/api";
import RecentFiles from "@cocalc/frontend/public/support/recent-files";
import { is_valid_email_address as isValidEmailAddress } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { openSupportTicketsPage } from "./open";
import type { Options as SupportOpenOptions } from "./url";

type TicketType = "problem" | "question" | "task" | "purchase" | "chat";

interface SupportFileRef {
  path?: string;
  project_id: string;
}

interface SupportDraft {
  body: string;
  files: SupportFileRef[];
  includeScreenshot: boolean;
  subject: string;
  type: TicketType;
}

const { Paragraph, Text } = Typography;

const MIN_BODY_LENGTH = 16;
const SUPPORT_DRAFT_STORAGE_PREFIX = "cocalc:support-draft:v1:";
const ALL_TICKET_TYPES: TicketType[] = [
  "problem",
  "question",
  "task",
  "purchase",
  "chat",
];

function normalizeType(value?: string): TicketType {
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

function defaultBodyForType(type: TicketType): string {
  switch (type) {
    case "problem":
      return [
        "**What did you do exactly?**",
        "",
        "**What happened?**",
        "",
        "**How did this differ from what you expected?**",
      ].join("\n");
    case "question":
      return [
        "**What is your question?**",
        "",
        "**What have you tried so far?**",
      ].join("\n");
    case "task":
      return [
        "**What software or configuration do you need?**",
        "",
        "**How do you plan to use it?**",
        "",
        "**How can we test that it works?**",
      ].join("\n");
    case "purchase":
      return [
        "**What would you like to purchase?**",
        "",
        "**Roughly how many users or projects are involved?**",
        "",
        "**Are there any timing, pricing, or deployment constraints?**",
      ].join("\n");
    case "chat":
      return [
        "**What would you like to discuss in the video chat?**",
        "",
        "**What outcome are you hoping for?**",
        "",
        "**Do you have any scheduling constraints?**",
      ].join("\n");
    default:
      return "";
  }
}

function appendMarkdownImage(
  body: string,
  url: string,
  label = "Image",
): string {
  const trimmed = body.trimEnd();
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}![${label}](${url})\n`;
}

async function waitForSupportModalVisibilityChange(): Promise<void> {
  if (typeof window === "undefined") return;
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

async function captureScreenshotBlob(): Promise<Blob> {
  const mediaDevices = navigator?.mediaDevices as MediaDevices | undefined;
  if (typeof mediaDevices?.getDisplayMedia !== "function") {
    throw Error("Screenshot capture is not supported by this browser.");
  }
  const stream = await mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    await new Promise<void>((resolve) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        resolve();
        return;
      }
      video.onloadeddata = () => resolve();
    });
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context == null) {
      throw Error("Unable to capture screenshot.");
    }
    context.drawImage(video, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob == null) {
          reject(new Error("Unable to encode screenshot."));
          return;
        }
        resolve(blob);
      }, "image/png");
    });
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

function submitButtonLabel(params: {
  email: string;
  body: string;
  subject: string;
  submitting: boolean;
  successUrl: string;
  submitError: string;
  type: TicketType;
  hasRequired: boolean;
}): string {
  const {
    body,
    email,
    hasRequired,
    subject,
    submitError,
    submitting,
    successUrl,
    type,
  } = params;
  if (submitting) return "Submitting...";
  if (successUrl) return "Ticket created";
  if (submitError) return "Fix the error above to try again";
  if (!isValidEmailAddress(email)) return "Enter a valid email address";
  if (!subject.trim()) return "Enter a subject";
  if (body.trim().length < MIN_BODY_LENGTH) {
    return type === "chat"
      ? "Describe the video chat you want"
      : `Describe your ${type} in more detail`;
  }
  if (!hasRequired) return "Replace the required placeholder text";
  return "Create support ticket";
}

function loadDraft(key: string): SupportDraft | undefined {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed == null) return;
    return {
      body: typeof parsed.body === "string" ? parsed.body : "",
      files: Array.isArray(parsed.files) ? parsed.files : [],
      includeScreenshot: !!parsed.includeScreenshot,
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      type: normalizeType(parsed.type),
    };
  } catch {
    return;
  }
}

export default function SupportCreateModal() {
  const pageActions = useActions("page");
  const accountEmail = useTypedRedux("account", "email_address") ?? "";
  const supportConfigured = !!useTypedRedux("customize", "zendesk");
  const initialOptions =
    useTypedRedux("page", "supportModalOptions") ?? ({} as SupportOpenOptions);

  const [body, setBody] = useState(initialOptions.body ?? "");
  const [email, setEmail] = useState(accountEmail);
  const [files, setFiles] = useState<SupportFileRef[]>([]);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [lastImageUrl, setLastImageUrl] = useState("");
  const [subject, setSubject] = useState(initialOptions.subject ?? "");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [successUrl, setSuccessUrl] = useState("");
  const [type, setType] = useState<TicketType>(
    normalizeType(initialOptions.type),
  );
  const draftStorageKey = useMemo(
    () => `${SUPPORT_DRAFT_STORAGE_PREFIX}${accountEmail || "signed-in-user"}`,
    [accountEmail],
  );

  useEffect(() => {
    setEmail(accountEmail);
  }, [accountEmail]);

  useEffect(() => {
    const draft = loadDraft(draftStorageKey);
    setBody(
      draft?.body ??
        initialOptions.body ??
        defaultBodyForType(normalizeType(initialOptions.type)),
    );
    setFiles(draft?.files ?? []);
    setIncludeScreenshot(draft?.includeScreenshot ?? false);
    setLastImageUrl("");
    setSubject(draft?.subject ?? initialOptions.subject ?? "");
    setSubmitError("");
    setSubmitting(false);
    setSuccessUrl("");
    setType(draft?.type ?? normalizeType(initialOptions.type));
  }, [
    draftStorageKey,
    initialOptions.body,
    initialOptions.subject,
    initialOptions.type,
    initialOptions.url,
    initialOptions.required,
  ]);

  useEffect(() => {
    const nextTemplate = defaultBodyForType(type);
    if (!nextTemplate) return;
    setBody((current) => {
      const trimmed = current.trim();
      const initialTemplate = defaultBodyForType(
        normalizeType(initialOptions.type),
      );
      if (
        trimmed.length === 0 ||
        trimmed === initialTemplate.trim() ||
        ALL_TICKET_TYPES.some(
          (ticketType) => trimmed === defaultBodyForType(ticketType).trim(),
        )
      ) {
        return nextTemplate;
      }
      return current;
    });
  }, [type, initialOptions.type]);

  useEffect(() => {
    if (typeof window === "undefined" || successUrl) return;
    const draft: SupportDraft = {
      body,
      files,
      includeScreenshot,
      subject,
      type,
    };
    try {
      window.localStorage.setItem(draftStorageKey, JSON.stringify(draft));
    } catch {
      // Ignore localStorage quota/access issues; the modal still works.
    }
  }, [
    body,
    draftStorageKey,
    files,
    includeScreenshot,
    subject,
    successUrl,
    type,
  ]);

  const hasRequired =
    !initialOptions.required || !body.includes(initialOptions.required);
  const canSubmit =
    supportConfigured &&
    !submitting &&
    !successUrl &&
    isValidEmailAddress(email) &&
    subject.trim().length > 0 &&
    body.trim().length >= MIN_BODY_LENGTH &&
    hasRequired;

  const currentUrl = useMemo(() => {
    if (initialOptions.url?.trim()) {
      return initialOptions.url.trim();
    }
    return `${window.location.origin}${window.location.pathname}${window.location.search}`;
  }, [initialOptions.url]);

  async function captureSupportScreenshotBlob(): Promise<Blob> {
    pageActions?.setState?.({ supportModalHidden: true });
    await waitForSupportModalVisibilityChange();
    try {
      return await captureScreenshotBlob();
    } finally {
      pageActions?.setState?.({ supportModalHidden: false });
      await waitForSupportModalVisibilityChange();
    }
  }

  async function attachScreenshot(input: string): Promise<string> {
    if (!includeScreenshot) {
      return input;
    }
    const screenshot = await captureSupportScreenshotBlob();
    const { url } = await uploadBlobImage({
      file: screenshot,
      filename: `support-screenshot-${Date.now()}.png`,
    });
    return appendMarkdownImage(input, url, "Screenshot");
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const normalizedBody = await attachScreenshot(body);
      const result = await api("support/create-ticket", {
        options: {
          body: normalizedBody,
          email,
          files,
          info: {
            browser: navigator.userAgent,
            context: initialOptions.context,
            userAgent: navigator.userAgent,
          },
          subject,
          type,
          url: currentUrl,
        },
      });
      if (result?.error) {
        throw Error(result.error);
      }
      try {
        window.localStorage.removeItem(draftStorageKey);
      } catch {
        // Ignore storage cleanup errors after successful submit.
      }
      setSuccessUrl(result?.url ?? "");
    } catch (err) {
      setSubmitError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  }

  function clearDraft(): void {
    try {
      window.localStorage.removeItem(draftStorageKey);
    } catch {
      // Ignore localStorage failures; reset the in-memory draft anyway.
    }
    setBody(initialOptions.body ?? "");
    setFiles([]);
    setIncludeScreenshot(false);
    setLastImageUrl("");
    setSubject(initialOptions.subject ?? "");
    setSubmitError("");
    setSuccessUrl("");
    setType(normalizeType(initialOptions.type));
  }

  const buttonText = submitButtonLabel({
    body,
    email,
    hasRequired,
    subject,
    submitError,
    submitting,
    successUrl,
    type,
  });

  if (!supportConfigured) {
    return (
      <Alert
        type="error"
        showIcon
        title="Support ticket creation is not configured."
      />
    );
  }

  if (successUrl) {
    return (
      <Space orientation="vertical" size="large" style={{ width: "100%" }}>
        <Alert
          type="success"
          showIcon
          title="Successfully created support ticket"
          description={
            <a href={successUrl} target="_blank" rel="noreferrer noopener">
              {successUrl}
            </a>
          }
        />
        <Space wrap>
          <Button
            type="primary"
            onClick={() => {
              openSupportTicketsPage();
            }}
          >
            View my tickets
          </Button>
          <Button onClick={() => pageActions.settings("")}>Close</Button>
        </Space>
      </Space>
    );
  }

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        title="This draft is not cleared until you explicitly clear it or submit the ticket."
        description="You can close and reopen this modal while gathering evidence, copying error messages, or pasting screenshots. The body uses the same markdown / rich-text composer as chat, supports pasted and dropped images, and converts those images to absolute links before the Zendesk ticket is created."
      />
      {initialOptions.required ? (
        <Alert
          type="warning"
          showIcon
          title="Replace the required placeholder text before submitting."
          description={`Update every '${initialOptions.required}' placeholder with the requested details.`}
        />
      ) : null}
      {submitError ? (
        <Alert
          type="error"
          showIcon
          title="Unable to create support ticket"
          description={submitError}
        />
      ) : null}
      <div>
        <Text strong>Email</Text>
        <Input
          disabled={submitting}
          placeholder="Email address..."
          style={{ marginTop: 8 }}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div>
        <Text strong>Subject</Text>
        <Input
          disabled={submitting}
          placeholder="Summarize what this is about..."
          style={{ marginTop: 8 }}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <div>
        <Text strong>Type</Text>
        <div style={{ marginTop: 8 }}>
          <Radio.Group
            disabled={submitting}
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <Space wrap>
              <Radio value="problem">Problem</Radio>
              <Radio value="question">Question</Radio>
              <Radio value="task">Task</Radio>
              <Radio value="purchase">Purchase</Radio>
              <Radio value="chat">Video chat</Radio>
            </Space>
          </Radio.Group>
        </div>
      </div>
      <div>
        <Text strong>Details</Text>
        <div
          style={{
            marginTop: 8,
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: 12,
            padding: 8,
            background: "white",
          }}
        >
          <ChatInput
            key={`support-create-${currentUrl}`}
            autoGrowMaxHeight={320}
            enableMentions={false}
            enableUpload={true}
            fixedMode="editor"
            height="220px"
            input={body}
            isFocused
            on_send={() => undefined}
            onChange={(value) => setBody(value)}
            syncdb={undefined}
            date={-1}
            placeholder="Describe what happened, what you expected, and any steps we should follow to reproduce the issue."
          />
        </div>
      </div>
      <div>
        <Text strong>Images</Text>
        <Paragraph type="secondary" style={{ marginTop: 4 }}>
          You can paste or drop images directly into the composer above. This
          extra upload box is useful when you want to crop an image before it is
          inserted into the ticket body. Every image is converted to a clickable
          absolute link for Zendesk.
        </Paragraph>
        <ThreadImageUpload
          modalTitle="Crop support image"
          uploadText="Click or drag an image, then crop if needed"
          value={lastImageUrl}
          onChange={(value) => {
            setLastImageUrl(value);
            setBody((current) => appendMarkdownImage(current, value));
          }}
        />
      </div>
      <Checkbox
        checked={includeScreenshot}
        disabled={submitting}
        onChange={(e) => setIncludeScreenshot(e.target.checked)}
      >
        Include a screenshot when I submit this ticket
      </Checkbox>
      <div>
        <Text strong>Relevant files</Text>
        <div style={{ marginTop: 8 }}>
          <RecentFiles disabled={submitting} onChange={setFiles} />
        </div>
      </div>
      <Divider style={{ margin: 0 }} />
      <Space style={{ justifyContent: "space-between", width: "100%" }} wrap>
        <Space wrap>
          <Button onClick={() => clearDraft()}>Clear draft</Button>
          <Button onClick={() => openSupportTicketsPage()}>View tickets</Button>
        </Space>
        <Space wrap>
          <Button onClick={() => pageActions.settings("")}>Cancel</Button>
          <Button
            disabled={!canSubmit}
            loading={submitting}
            type="primary"
            onClick={() => void submit()}
          >
            {buttonText}
          </Button>
        </Space>
      </Space>
    </Space>
  );
}
